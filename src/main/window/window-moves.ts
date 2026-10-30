import { randomUUID } from "node:crypto";
import type { WindowIpc } from "./window-ipc";
import type { MoveContent, MovePlacement, WindowDestination } from "../../shared/windows";

interface MovePort {
  label: string;
  owns(content: MoveContent): boolean;
  send(channel: string, ...args: unknown[]): void;
  move(content: MoveContent, target: number): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
function content(value: unknown): value is MoveContent {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    id(value["id"]) &&
    (value["kind"] === "terminal" || value["kind"] === "preview")
  );
}
function placement(value: unknown): value is MovePlacement {
  return (
    value === null ||
    (record(value) &&
      Object.keys(value).length === 2 &&
      id(value["tile"]) &&
      typeof value["zone"] === "string" &&
      ["center", "left", "right", "up", "down"].includes(value["zone"]))
  );
}

/** App-wide gesture authority. DataTransfer never supplies a token or an item ID. */
export class WindowMoves {
  private readonly ports = new Map<number, MovePort>();
  private drag:
    | { token: string; source: number; content: MoveContent; expires: number }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<
    string,
    { target: number; finish: (accepted: boolean) => void }
  >();
  private readonly busy = new Set<number>();

  private publish(): void {
    for (const [window, port] of this.ports)
      port.send("windows:drag", this.drag && this.drag.source !== window ? this.drag.token : null);
  }
  private cancel(): void {
    clearTimeout(this.timer);
    this.drag = undefined;
    this.publish();
  }
  private async transfer(
    source: number,
    target: number,
    item: MoveContent,
    at: MovePlacement,
  ): Promise<void> {
    const origin = this.ports.get(source);
    const destination = this.ports.get(target);
    if (
      !origin ||
      !destination ||
      source === target ||
      !origin.owns(item) ||
      this.busy.has(source) ||
      this.busy.has(target)
    )
      throw new Error("Unable to move tile");
    this.busy.add(source);
    this.busy.add(target);
    const request = randomUUID();
    try {
      const accepted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          finish(false);
        }, 5000);
        const finish = (value: boolean) => {
          clearTimeout(timer);
          this.pending.delete(request);
          resolve(value);
        };
        this.pending.set(request, { target, finish });
        destination.send("windows:prepare-move", request, at);
      });
      if (
        !accepted ||
        this.ports.get(source) !== origin ||
        this.ports.get(target) !== destination ||
        !origin.owns(item)
      )
        throw new Error("Unable to move tile");
      await origin.move(item, target);
      destination.send("windows:finish-move", request, item);
    } catch (error) {
      destination.send("windows:finish-move", request, null);
      throw error;
    } finally {
      this.busy.delete(source);
      this.busy.delete(target);
    }
  }
  /** Existing pop-outs participate in the same source-window exclusion. */
  async popout(source: number, operation: () => Promise<unknown>): Promise<void> {
    if (!this.ports.has(source) || this.busy.has(source)) throw new Error("Unable to move tile");
    this.busy.add(source);
    try {
      await operation();
    } finally {
      this.busy.delete(source);
    }
  }
  attach(window: number, ipc: WindowIpc, port: MovePort): () => void {
    this.ports.set(window, port);
    ipc.handle("windows:list", (_event, ...args): WindowDestination[] => {
      if (args.length) throw new Error("Invalid window request");
      return [...this.ports]
        .filter(([id]) => id !== window)
        .map(([id, entry]) => ({ id, label: entry.label }));
    });
    ipc.handle("windows:begin-drag", (_event, ...args) => {
      const [item] = args;
      if (args.length !== 1 || !content(item) || !port.owns(item) || this.busy.has(window))
        throw new Error("Invalid drag origin");
      this.cancel();
      const token = randomUUID();
      this.drag = {
        token,
        source: window,
        content: { kind: item.kind, id: item.id },
        expires: Date.now() + 15000,
      };
      this.timer = setTimeout(() => {
        this.cancel();
      }, 15000);
      this.publish();
      return token;
    });
    ipc.handle("windows:end-drag", (_event, ...args) => {
      const [token] = args;
      if (args.length !== 1 || !id(token)) throw new Error("Invalid drag token");
      if (this.drag?.source === window && this.drag.token === token) this.cancel();
    });
    ipc.handle("windows:drop", async (_event, ...args) => {
      const [token, at] = args;
      if (args.length !== 2 || !id(token) || !placement(at)) throw new Error("Invalid drop");
      const drag = this.drag;
      if (!drag || drag.token !== token || drag.expires <= Date.now() || drag.source === window)
        throw new Error("Unknown drag token");
      // Consume before any asynchronous placement/transfer, including refusal.
      this.cancel();
      await this.transfer(drag.source, window, drag.content, at);
    });
    ipc.handle("windows:move", async (_event, ...args) => {
      const [item, target] = args;
      if (
        args.length !== 2 ||
        !content(item) ||
        typeof target !== "number" ||
        !Number.isSafeInteger(target)
      )
        throw new Error("Invalid window move");
      await this.transfer(window, target, { kind: item.kind, id: item.id }, null);
    });
    ipc.handle("windows:move-ready", (_event, ...args) => {
      const [request, accepted] = args;
      if (args.length !== 2 || typeof request !== "string" || typeof accepted !== "boolean")
        throw new Error("Invalid placement reply");
      const pending = this.pending.get(request);
      if (!pending || pending.target !== window) throw new Error("Unknown placement request");
      pending.finish(accepted);
    });
    return () => {
      this.ports.delete(window);
      if (this.drag?.source === window) this.cancel();
      for (const pending of this.pending.values())
        if (pending.target === window) pending.finish(false);
      for (const channel of [
        "windows:list",
        "windows:begin-drag",
        "windows:end-drag",
        "windows:drop",
        "windows:move",
        "windows:move-ready",
      ])
        ipc.removeHandler(channel);
    };
  }
}
