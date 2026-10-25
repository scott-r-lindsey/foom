import { RemoteTransport } from "./remote-transport";
import type { RemoteTarget } from "../../shared/remote-host";
import type { ChildInput } from "../../shared/child-input";
import type { TerminalThemeChoice } from "../../shared/terminal-theme";
import { parseTerminalThemeChoice, resolveTerminalTheme } from "../../shared/terminal-themes";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, utilityProcess, nativeTheme } from "electron";
import type { Details, UtilityProcess } from "electron";
import type { TerminalTelemetry, TerminalSpec } from "../../shared/desktop";
import type { HostRequest } from "../../shared/terminal-host";
import { hostRequest, hostResponse } from "../../shared/terminal-host-protocol";

type Command = HostRequest extends infer R
  ? R extends HostRequest
    ? Omit<R, "request">
    : never
  : never;
type Pending = {
  id: string;
  resolve: (result: {
    lines: string[];
    signaled?: boolean;
    title?: string;
    cols?: number;
    rows?: number;
  }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type HostDiagnostics = {
  serviceName: string;
  pid?: number | undefined;
  exitCode?: number;
  gone?: Pick<Details, "type" | "reason" | "exitCode">;
  stderr: string;
};
const HOST_STDERR_LIMIT = 8192;

type Session = {
  alive: boolean;
  available: boolean;
  view?: string;
  send?: (token: string, data: string) => void;
};

/** Main owns capabilities; the utility process owns PTYs and parses their output. */
export class TerminalHostClient {
  private child: UtilityProcess | RemoteTransport | undefined;
  private readonly remotes = new Map<string, TerminalHostClient>();
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private disposed = false;
  private shuttingDown = false;
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private diagnostics: HostDiagnostics | undefined;
  private releaseDiagnostics: (() => void) | undefined;
  private failure: Error | undefined;

  private themeChoice: TerminalThemeChoice = "follow";
  private themeKey = "";

  setTheme(choice: TerminalThemeChoice): void {
    for (const client of this.remotes.values()) client.setTheme(choice);
    this.themeChoice = parseTerminalThemeChoice(choice);
    this.updateTheme();
  }

  private readonly updateTheme = () => {
    const theme = resolveTerminalTheme(this.themeChoice, nativeTheme.shouldUseDarkColors);
    const key = JSON.stringify(theme);
    if (this.themeKey === key) return;
    this.themeKey = key;
    for (const id of this.sessions.keys())
      this.notify({ type: "theme", id, dark: nativeTheme.shouldUseDarkColors, theme });
  };

  constructor(
    private readonly onExit: (id: string, code: number) => void,
    private readonly events: TerminalTelemetry = {},
    private readonly remote?: RemoteTarget,
  ) {
    nativeTheme.on("updated", this.updateTheme);
  }

  private start(): UtilityProcess | RemoteTransport {
    if (this.disposed) throw new Error("Terminal host disposed");
    if (this.child) return this.child;
    if (this.remote) {
      const child = new RemoteTransport(this.remote, app.getVersion());
      this.child = child;
      child.on("message", (message: unknown) => {
        this.receive(child, message);
      });
      child.once("exit", () => {
        this.fail(child);
      });
      return child;
    }
    this.releaseDiagnostics?.();
    this.failure = undefined;
    this.diagnostics = undefined;
    const diagnostics: HostDiagnostics = {
      serviceName: `Foom terminal host ${randomUUID()}`,
      stderr: "",
    };
    const child = utilityProcess.fork(join(__dirname, "../../terminal-host/terminal-host.js"), [], {
      serviceName: diagnostics.serviceName,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    this.diagnostics = diagnostics;
    let stderr = Buffer.alloc(0);
    let abnormalExit = false;
    // Only the utility process's own stderr is piped. PTY output stays on the
    // validated message channel and must never be copied into diagnostics.
    child.stderr?.on("data", (chunk: unknown) => {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.subarray(-HOST_STDERR_LIMIT)
        : typeof chunk === "string"
          ? Buffer.from(chunk.slice(-HOST_STDERR_LIMIT)).subarray(-HOST_STDERR_LIMIT)
          : undefined;
      if (!bytes) return;
      stderr = Buffer.concat([stderr, bytes]).subarray(-HOST_STDERR_LIMIT);
      diagnostics.stderr = stderr.toString("utf8");
      if (abnormalExit && this.diagnostics === diagnostics && this.failure) {
        this.failure.message = this.failureMessage(diagnostics);
        console.error("Terminal host diagnostic:", JSON.stringify(diagnostics));
      }
    });
    child.once("spawn", () => {
      diagnostics.pid = child.pid;
    });
    const gone = (_event: Electron.Event, details: Details) => {
      // Electron reports the fork's serviceName in name (not serviceName).
      if (details.type !== "Utility" || details.name !== diagnostics.serviceName) return;
      diagnostics.gone = {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      };
      if (details.reason !== "clean-exit") abnormalExit = true;
      // The app and utility exit events have no documented ordering. Preserve
      // late crash details in the same error and log them separately for CI.
      if (this.diagnostics === diagnostics && this.failure)
        this.failure.message = this.failureMessage(diagnostics);
      if (abnormalExit) console.error("Terminal host diagnostic:", JSON.stringify(diagnostics));
    };
    app.on("child-process-gone", gone);
    this.releaseDiagnostics = () => {
      app.removeListener("child-process-gone", gone);
    };
    child.on("message", (message: unknown) => {
      this.receive(child, message);
    });
    child.once("exit", (code) => {
      diagnostics.exitCode = code;
      // A zero exit while serving requests is still an unexpected host failure.
      abnormalExit ||= code !== 0 || !this.disposed || this.pending.size > 0;
      if (abnormalExit) console.error("Terminal host diagnostic:", JSON.stringify(diagnostics));
      this.fail(child);
    });
    return child;
  }

  private receive(child: UtilityProcess | RemoteTransport, message: unknown): void {
    if (this.child !== child || !hostResponse(message)) return;
    if (message.type === "activity") {
      const entries = message.entries.filter((entry) => this.sessions.get(entry.id)?.alive);
      if (entries.length) this.events.onActivity?.(entries);
      return;
    }
    const session = this.sessions.get(message.id);
    if (message.type === "evidence") {
      if (session?.alive) this.events.onEvidence?.(message.id, message.evidence);
    } else if (message.type === "foreground") {
      if (session?.alive) this.events.onForeground?.(message.id, message.name);
    } else if (message.type === "shell-state") {
      if (session?.alive) this.events.onShellState?.(message.id, message.state);
    } else if (message.type === "output") {
      if (session?.alive) this.events.onOutput?.(message.id);
    } else if (message.type === "quiet") {
      if (session?.alive) this.events.onQuiet?.(message.id);
    } else if (message.type === "data") {
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
      else pending.resolve(message);
    }
  }

  private failureMessage(diagnostics: HostDiagnostics): string {
    return `Terminal host stopped: ${JSON.stringify(diagnostics)}`;
  }

  private fail(child: UtilityProcess | RemoteTransport): void {
    if (this.child !== child) return;
    this.child = undefined;
    child.kill();
    const diagnostics = this.diagnostics;
    const error = new Error(
      diagnostics ? this.failureMessage(diagnostics) : "Terminal host stopped",
      {
        cause: diagnostics,
      },
    );
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
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

  private async request(command: Command): Promise<{
    lines: string[];
    signaled?: boolean;
    title?: string;
    cols?: number;
    rows?: number;
  }> {
    const request = ++this.sequence;
    const message = { ...command, request };
    if (!hostRequest(message)) throw new Error("Invalid terminal host request");
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.fail(child);
        },
        command.type === "shutdown"
          ? 15000
          : this.remote && command.type === "create"
            ? 125000
            : 10000,
      );
      this.pending.set(request, { id: command.id, resolve, reject, timer });
      try {
        child.postMessage(message);
      } catch {
        this.fail(child);
      }
    });
  }

  async create(spec: TerminalSpec): Promise<string> {
    if (this.disposed) throw new Error("Terminal host disposed");
    if (this.shuttingDown) throw new Error("Terminals are shutting down");
    const id = spec.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(id) || this.sessions.has(id) || this.remotes.has(id))
      throw new Error("Invalid or occupied terminal ID");
    if (spec.remote) {
      if (this.remote) throw new Error("Nested remote target");
      const client = new TerminalHostClient(this.onExit, this.events, spec.remote);
      client.setTheme(this.themeChoice);
      this.remotes.set(id, client);
      const local = { ...spec };
      delete local.remote;
      try {
        await client.create({ ...local, id });
      } catch (error) {
        this.remotes.delete(id);
        await client.dispose();
        throw error;
      }
      return id;
    }
    this.sessions.set(id, { alive: true, available: true });
    try {
      await this.request({
        type: "create",
        id,
        spec,
        dark: nativeTheme.shouldUseDarkColors,
        theme: resolveTerminalTheme(this.themeChoice, nativeTheme.shouldUseDarkColors),
      });
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return id;
  }

  async attach(id: string, send: (token: string, data: string) => void): Promise<void> {
    if (this.remotes.has(id)) return this.remotes.get(id)?.attach(id, send);
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
    if (this.remotes.has(id)) {
      this.remotes.get(id)?.write(id, data);
      return;
    }
    this.notify({ type: "write", id, data });
  }
  async reply(id: string, data: string): Promise<void> {
    if (this.remotes.has(id)) return this.remotes.get(id)?.reply(id, data);
    await this.request({ type: "write", id, data });
  }
  async childInput(id: string, input: ChildInput): Promise<void> {
    if (this.remotes.has(id)) return this.remotes.get(id)?.childInput(id, input);
    await this.request({ type: "child-input", id, input });
  }
  resize(id: string, cols: number, rows: number): void {
    if (this.remotes.has(id)) {
      this.remotes.get(id)?.resize(id, cols, rows);
      return;
    }
    this.notify({ type: "resize", id, cols, rows });
  }
  acknowledge(id: string, token: string, count: number): void {
    if (this.remotes.has(id)) {
      this.remotes.get(id)?.acknowledge(id, token, count);
      return;
    }
    this.notify({ type: "acknowledge", id, token, count });
  }
  detach(id: string): void {
    if (this.remotes.has(id)) {
      this.remotes.get(id)?.detach(id);
      return;
    }
    const session = this.sessions.get(id);
    if (session) delete session.send;
    this.notify({ type: "detach", id });
  }
  async screen(
    id: string,
  ): Promise<{ lines: string[]; title: string; cols: number; rows: number }> {
    const remote = this.remotes.get(id);
    if (remote) return remote.screen(id);
    if (!this.sessions.get(id)?.available || !this.child)
      throw new Error("Terminal host unavailable");
    const result = await this.request({ type: "screen", id });
    if (result.title === undefined || result.cols === undefined || result.rows === undefined)
      throw new Error("Missing terminal title");
    return { lines: result.lines, title: result.title, cols: result.cols, rows: result.rows };
  }
  async tail(id: string, lines: number): Promise<string[]> {
    const remote = this.remotes.get(id);
    if (remote) return remote.tail(id, lines);
    if (!this.sessions.get(id)?.available || !this.child)
      throw new Error("Terminal host unavailable");
    return (await this.request({ type: "tail", id, lines })).lines;
  }
  async stop(id: string): Promise<boolean> {
    const remote = this.remotes.get(id);
    if (remote) return remote.stop(id);
    if (!this.sessions.get(id)?.alive) return false;
    const result = await this.request({ type: "stop", id });
    if (result.signaled === undefined) throw new Error("Missing terminal stop result");
    return result.signaled;
  }
  async kill(id: string): Promise<void> {
    const remote = this.remotes.get(id);
    if (remote) {
      await remote.kill(id);
      await remote.dispose();
      this.remotes.delete(id);
      return;
    }
    if (!this.sessions.has(id)) return;
    // A failed host has no remaining screen to remove. Allow the renderer to restart.
    if (this.child && this.sessions.get(id)?.available) await this.request({ type: "kill", id });
    this.sessions.delete(id);
  }
  get runningCount(): number {
    const remoteCount = [...this.remotes.values()].reduce(
      (count, client) => count + client.runningCount,
      0,
    );
    return remoteCount + [...this.sessions.values()].filter((session) => session.alive).length;
  }
  get hasPendingExits(): boolean {
    if ([...this.remotes.values()].some((client) => client.hasPendingExits)) return true;
    return this.child !== undefined;
  }
  waitForExit(): Promise<void> {
    return this.dispose();
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.shuttingDown = true;
    this.stopping = (async () => {
      if (this.remotes.size)
        await Promise.all([...this.remotes.values()].map((client) => client.shutdown()));
      if (this.remote) {
        this.sessions.clear();
        this.child?.kill();
        return;
      }
      if (this.child) await this.request({ type: "shutdown", id: "host" });
      this.sessions.clear();
    })().catch((error: unknown) => {
      this.shuttingDown = false;
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    nativeTheme.removeListener("updated", this.updateTheme);
    const child = this.child;
    const remoteClosing = Promise.all([...this.remotes.values()].map((client) => client.dispose()));
    const localClosing = new Promise<void>((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.fail(child);
        resolve();
      }, 12000);
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
    this.closing = Promise.all([remoteClosing, localClosing]).then(() => {});
    void this.closing.then(() => {
      this.releaseDiagnostics?.();
      this.releaseDiagnostics = undefined;
    });
    return this.closing;
  }
}
