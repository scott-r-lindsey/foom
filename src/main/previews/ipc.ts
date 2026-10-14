import type { PreviewBounds } from "../../shared/previews";
import type { WindowIpc } from "../window/window-ipc";
import type { PreviewHost } from "./host";
import { previewId } from "./registry";

export function parseBounds(value: unknown): PreviewBounds {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 5 ||
    !("x" in value) ||
    !("y" in value) ||
    !("width" in value) ||
    !("height" in value) ||
    !("visible" in value) ||
    typeof value.visible !== "boolean"
  )
    throw new Error("Invalid preview bounds");
  const { x, y, width, height, visible } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every((n) => Number.isFinite(n) && Math.abs(n) <= 20000) ||
    width < 0 ||
    height < 0
  )
    throw new Error("Invalid preview bounds");
  return { x, y, width, height, visible };
}
/** WindowIpcRouter validates the owning board and its top frame before dispatch. */
export function attachPreviews(
  ipc: WindowIpc,
  host: PreviewHost,
  humanClose: (id: string) => void = () => {},
): () => void {
  ipc.handle("preview:open", (_event, ...args) => {
    const [worktree, path] = args;
    if (
      args.length !== 2 ||
      typeof worktree !== "string" ||
      !worktree ||
      worktree.length > 4096 ||
      worktree.includes("\0") ||
      typeof path !== "string"
    )
      throw new Error("Invalid preview request");
    return host.open(worktree, path);
  });
  ipc.handle("preview:close", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !previewId(id)) throw new Error("Invalid preview ID");
    humanClose(id);
    return host.close(id);
  });
  ipc.handle("preview:bounds", (_event, ...args) => {
    const [id, bounds] = args;
    if (args.length !== 2 || !previewId(id)) throw new Error("Invalid preview ID");
    host.bounds(id, parseBounds(bounds));
  });
  return () => {
    for (const channel of ["preview:open", "preview:close", "preview:bounds"])
      ipc.removeHandler(channel);
  };
}
