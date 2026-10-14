import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { WindowIpc } from "../window/window-ipc";
import type { Placement } from "../control/previews";
import { previewId } from "./registry";

/** Bounded board round trip. Only its registered, trusted top frame can answer. */
export class PreviewPlacement {
  private readonly pending = new Map<
    string,
    { id: string; finish: (placement: Placement) => void }
  >();
  constructor(
    private readonly contents: WebContents,
    private readonly ipc: WindowIpc,
  ) {
    ipc.handle("preview:placed", (_event, ...args) => {
      const [request, id, placement] = args;
      if (
        args.length !== 3 ||
        typeof request !== "string" ||
        !previewId(id) ||
        typeof placement !== "string" ||
        !["landing", "empty", "column", "replace", "existing", "sidebar"].includes(placement)
      )
        throw new Error("Invalid preview placement");
      const pending = this.pending.get(request);
      if (!pending || pending.id !== id) throw new Error("Unknown preview placement");
      pending.finish(
        placement === "landing" ||
          placement === "empty" ||
          placement === "column" ||
          placement === "replace" ||
          placement === "existing"
          ? placement
          : "sidebar",
      );
    });
  }
  place(id: string): Promise<Placement> {
    if (this.contents.isDestroyed()) return Promise.resolve("sidebar");
    return new Promise((resolve) => {
      const request = randomUUID();
      const timer = setTimeout(() => {
        finish("sidebar");
      }, 5000);
      const finish = (placement: Placement) => {
        clearTimeout(timer);
        this.pending.delete(request);
        resolve(placement);
      };
      this.pending.set(request, { id, finish });
      this.contents.send("preview:place", request, id, Date.now() + 5000);
    });
  }
  dispose(): void {
    this.ipc.removeHandler("preview:placed");
    for (const pending of this.pending.values()) pending.finish("sidebar");
  }
}
