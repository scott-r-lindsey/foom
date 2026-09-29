import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import type { TerminalSpec } from "./shared/desktop";
import type { HostRequest } from "./shared/terminal-host";
import { hostRequest, hostResponse } from "./terminal-host-protocol";

type Command = HostRequest extends infer R
  ? R extends HostRequest
    ? Omit<R, "request">
    : never
  : never;
type Pending = {
  id: string;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Session = {
  alive: boolean;
  available: boolean;
  view?: string;
  send?: (token: string, data: string) => void;
};

/** Main owns capabilities; the utility process owns PTYs and parses their output. */
export class TerminalHostClient {
  private child: UtilityProcess | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private disposed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly onExit: (id: string, code: number) => void) {}

  private start(): UtilityProcess {
    if (this.disposed) throw new Error("Terminal host disposed");
    if (this.child) return this.child;
    const child = utilityProcess.fork(join(__dirname, "terminal-host.js"), [], {
      serviceName: "Foom terminal host",
      stdio: "ignore",
    });
    this.child = child;
    child.on("message", (message: unknown) => {
      if (this.child !== child || !hostResponse(message)) return;
      const session = this.sessions.get(message.id);
      if (message.type === "data") {
        if (session?.view === message.view) session.send?.(message.token, message.data);
      } else if (message.type === "exit") {
        if (!session?.alive) return;
        session.alive = false;
        this.onExit(message.id, message.code);
      } else {
        const pending = this.pending.get(message.request);
        if (!pending || pending.id !== message.id) return;
        this.pending.delete(message.request);
        clearTimeout(pending.timer);
        if (message.type === "error") pending.reject(new Error("Terminal host operation failed"));
        else pending.resolve(message.lines);
      }
    });
    child.once("exit", () => {
      this.fail(child);
    });
    return child;
  }

  private fail(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Terminal host stopped"));
    }
    this.pending.clear();
    for (const [id, session] of this.sessions) {
      delete session.send;
      session.available = false;
      if (session.alive) {
        session.alive = false;
        if (!this.disposed) this.onExit(id, -1);
      }
    }
  }

  private async request(command: Command): Promise<string[]> {
    const request = ++this.sequence;
    const message = { ...command, request };
    if (!hostRequest(message)) throw new Error("Invalid terminal host request");
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(child);
      }, 10000);
      this.pending.set(request, { id: command.id, resolve, reject, timer });
      try {
        child.postMessage(message);
      } catch {
        this.fail(child);
      }
    });
  }

  async create(spec: TerminalSpec): Promise<string> {
    const id = randomUUID();
    this.sessions.set(id, { alive: true, available: true });
    try {
      await this.request({ type: "create", id, spec });
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return id;
  }

  async attach(id: string, send: (token: string, data: string) => void): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.available || !this.child) throw new Error("Terminal host unavailable");
    session.send = send;
    session.view = randomUUID();
    await this.request({ type: "attach", id, view: session.view });
  }

  private notify(command: Command): void {
    if (this.disposed || !this.child || !this.sessions.get(command.id)?.available) return;
    // Invalid/stale commands cannot leave an unhandled rejection in an IPC listener.
    void this.request(command).catch(() => {});
  }
  write(id: string, data: string): void {
    this.notify({ type: "write", id, data });
  }
  resize(id: string, cols: number, rows: number): void {
    this.notify({ type: "resize", id, cols, rows });
  }
  acknowledge(id: string, token: string, count: number): void {
    this.notify({ type: "acknowledge", id, token, count });
  }
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (session) delete session.send;
    this.notify({ type: "detach", id });
  }
  async tail(id: string, lines: number): Promise<string[]> {
    if (!this.sessions.get(id)?.available || !this.child)
      throw new Error("Terminal host unavailable");
    return this.request({ type: "tail", id, lines });
  }
  async kill(id: string): Promise<void> {
    if (!this.sessions.has(id)) return;
    // A failed host has no remaining screen to remove. Allow the renderer to restart.
    if (this.child && this.sessions.get(id)?.available) await this.request({ type: "kill", id });
    this.sessions.delete(id);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    const child = this.child;
    this.closing = new Promise((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.fail(child);
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.postMessage("shutdown");
      } catch {
        clearTimeout(timer);
        this.fail(child);
        resolve();
      }
    });
    return this.closing;
  }
}
