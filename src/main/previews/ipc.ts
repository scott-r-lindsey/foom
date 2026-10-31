import { join } from "node:path";
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
  pick: (worktree: string) => Promise<string | null>,
  popout: (id: string) => Promise<void>,
  humanClose: (id: string) => void = () => {},
  copyText?: (text: string) => void | Promise<void>,
): () => void {
  const moving = new Set<string>();
  ipc.handle("preview:pick", (_event, ...args) => {
    const [worktree] = args;
    if (
      args.length !== 1 ||
      typeof worktree !== "string" ||
      !worktree ||
      worktree.length > 4096 ||
      worktree.includes("\0")
    )
      throw new Error("Invalid preview request");
    return pick(worktree);
  });
  ipc.handle("preview:copy-path", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !previewId(id)) throw new Error("Invalid preview ID");
    const record = host.registry.records.get(id);
    if (!record || record.bundled || !copyText) throw new Error("Copy unavailable");
    return copyText(join(record.worktree, record.relativePath));
  });
  ipc.handle("preview:reload", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !previewId(id)) throw new Error("Invalid preview ID");
    if (!host.registry.records.has(id)) throw new Error("Unknown preview ID");
    return host.reload(id);
  });
  ipc.handle("preview:close", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !previewId(id)) throw new Error("Invalid preview ID");
    if (!host.registry.records.has(id)) throw new Error("Unknown preview ID");
    humanClose(id);
    return host.close(id);
  });
  ipc.handle("preview:popout", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !previewId(id)) throw new Error("Invalid preview ID");
    if (!host.registry.records.has(id)) throw new Error("Unknown preview ID");
    if (moving.has(id)) throw new Error("Preview move in progress");
    moving.add(id);
    return Promise.resolve()
      .then(() => popout(id))
      .finally(() => moving.delete(id));
  });
  ipc.handle("preview:network", (_event, ...args) => {
    const [id, enabled] = args;
    if (args.length !== 2 || !previewId(id) || typeof enabled !== "boolean")
      throw new Error("Invalid preview network request");
    return host.network(id, enabled);
  });
  ipc.handle("preview:bounds", (_event, ...args) => {
    const [id, bounds] = args;
    if (args.length !== 2 || !previewId(id)) throw new Error("Invalid preview ID");
    host.bounds(id, parseBounds(bounds));
  });
  ipc.handle("preview:painted", (_event, ...args) => {
    const [id, version] = args;
    if (
      args.length !== 2 ||
      !previewId(id) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      throw new Error("Invalid preview paint acknowledgement");
    host.painted(id, version);
  });
  ipc.handle("preview:cover", (_event, ...args) => {
    if (args.length !== 1 || typeof args[0] !== "boolean")
      throw new Error("Invalid preview cover request");
    return host.cover(args[0]);
  });
  return () => {
    for (const channel of [
      "preview:copy-path",
      "preview:pick",
      "preview:popout",
      "preview:close",
      "preview:reload",
      "preview:bounds",
      "preview:cover",
      "preview:painted",
      "preview:network",
    ])
      ipc.removeHandler(channel);
  };
}
