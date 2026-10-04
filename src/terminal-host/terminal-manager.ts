import { prepareShell } from "./shell-integration";
import type { TerminalTheme } from "../shared/terminal-theme";
import { TerminalActivityMeter } from "./terminal-activity";
import { terminalSnapshot } from "./terminal-snapshot";
import { TerminalColors } from "../shared/terminal-colors";
import { randomUUID } from "node:crypto";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalTelemetry, TerminalSpec } from "../shared/desktop";

type View = { token: string; send: (token: string, data: string) => void };
type Session = {
  pty: IPty;
  screen: Terminal;
  serialize: SerializeAddon;
  colors: TerminalColors;
  subscriptions: IDisposable[];
  view?: View;
  pending: number;
  paused: boolean;
  parserPending: number;
  parserBlocked: boolean;
  viewBlocked: boolean;
  exited: boolean;
  terminationRequested: boolean;
  generation: number;
};

/** Utility-process state; no renderer is needed to consume PTY output. */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private shuttingDown = false;
  private readonly pendingExits = new Map<Session, Promise<void>>();

  private readonly activity: TerminalActivityMeter;
  constructor(
    private readonly onExit: (id: string, code: number) => void,
    private readonly events: TerminalTelemetry = {},
  ) {
    this.activity = new TerminalActivityMeter(events);
  }

  create(
    spec: TerminalSpec,
    id: string = randomUUID(),
    dark: boolean | TerminalTheme = false,
  ): string {
    if (this.shuttingDown) throw new Error("Terminals are shutting down");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(npm_|ELECTRON_)/i.test(key)) env[key] = value;
    }
    const shell = prepareShell(spec);
    let pty: IPty;
    try {
      pty = spawn(spec.command, [...(shell?.args ?? spec.args)], {
        name: "xterm-256color",
        // The OS cleanup path forks a Node helper, incompatible with RunAsNode=false.
        useConptyDll: true,
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: {
          ...env,
          ...spec.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "Foom",
        },
      });
    } catch (error) {
      shell?.dispose();
      throw error;
    }
    const screen = new Terminal({
      cols: spec.cols,
      rows: spec.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    screen.loadAddon(serialize);
    const colors = new TerminalColors(screen.parser, dark, (data) => {
      if (!session.exited) pty.write(data);
    });
    const session: Session = {
      colors,
      pty,
      screen,
      serialize,
      subscriptions: [],
      pending: 0,
      paused: false,
      parserPending: 0,
      parserBlocked: false,
      viewBlocked: false,
      exited: false,
      terminationRequested: false,
      generation: 0,
    };
    this.sessions.set(id, session);
    this.activity.start(id);
    session.subscriptions = [
      // The host is the response owner, whether or not a renderer is attached.
      screen.onData((data) => {
        if (!session.exited) pty.write(data);
      }),
      pty.onData((data) => {
        if (data && !session.exited) {
          this.events.onOutput?.(id);
          this.activity.output(id, data);
        }
        session.parserPending += data.length;
        if (session.parserPending > 262144) session.parserBlocked = true;
        this.updateFlow(session);
        screen.write(data, () => {
          if (!this.sessions.has(id)) return;
          if (data) this.activity.parsed(id, this.readTail(session, 1).at(-1) ?? "");
          session.parserPending -= data.length;
          if (session.parserPending < 65536) session.parserBlocked = false;
          this.deliver(session, data);
          this.updateFlow(session);
        });
      }),
    ];
    if (shell)
      session.subscriptions.push(
        screen.parser.registerOscHandler(633, (data) => {
          const state = shell.parse(data);
          if (state) this.events.onShellState?.(id, state);
          return Boolean(state);
        }),
      );
    let resolveExit: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.pendingExits.set(session, exited);
    // Keep this subscription after kill: killing a PTY only requests termination.
    const exitSubscription = pty.onExit(({ exitCode }) => {
      session.exited = true;
      shell?.dispose();
      this.activity.remove(id);
      this.pendingExits.delete(session);
      exitSubscription.dispose();
      resolveExit();
      if (!this.sessions.has(id)) return;
      // Preserve the final screen, and report exit after queued output has parsed.
      screen.write("", () => {
        if (this.sessions.has(id)) this.onExit(id, exitCode);
      });
    });
    return id;
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown terminal ID");
    return session;
  }

  private deliver(session: Session, data: string): void {
    if (!session.view) return;
    session.pending += data.length;
    if (session.pending > 262144) session.viewBlocked = true;
    this.updateFlow(session);
    session.view.send(session.view.token, data);
  }

  private updateFlow(session: Session): void {
    const blocked =
      !this.shuttingDown &&
      !session.terminationRequested &&
      (session.parserBlocked || session.viewBlocked);
    if (session.exited || session.paused === blocked) return;
    session.paused = blocked;
    if (blocked) session.pty.pause();
    else session.pty.resume();
  }

  write(id: string, data: string): void {
    const session = this.get(id);
    if (!session.exited) session.pty.write(data);
  }

  setTheme(id: string, dark: boolean | TerminalTheme): void {
    const session = this.get(id);
    session.screen.write("", () => {
      if (!this.sessions.has(id)) return;
      session.colors.reset(dark);
      this.deliver(session, session.colors.snapshot());
    });
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id);
    session.screen.resize(cols, rows);
    if (!session.exited) session.pty.resize(cols, rows);
  }

  async attach(id: string, send: View["send"]): Promise<void> {
    this.detach(id);
    const session = this.get(id);
    const generation = session.generation;
    await new Promise<void>((resolve, reject) => {
      // A parser barrier makes the snapshot and subsequent live stream contiguous.
      session.screen.write("", () => {
        if (this.sessions.has(id) && generation === session.generation) {
          try {
            const snapshot =
              session.colors.snapshot() + terminalSnapshot(session.screen, session.serialize);
            session.view = { token: randomUUID(), send };
            this.deliver(session, snapshot);
          } catch (error) {
            reject(new Error("Unable to snapshot terminal", { cause: error }));
            return;
          }
        }
        resolve();
      });
    });
  }

  detach(id: string): void {
    const session = this.get(id);
    delete session.view;
    session.generation++;
    session.pending = 0;
    session.viewBlocked = false;
    this.updateFlow(session);
  }

  acknowledge(id: string, token: string, count: number): void {
    const session = this.get(id);
    if (
      session.view?.token !== token ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > session.pending
    )
      return;
    session.pending -= count;
    if (session.pending < 65536) session.viewBlocked = false;
    this.updateFlow(session);
  }

  async tail(id: string, lines: number): Promise<string[]> {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
      throw new Error("Invalid tail length");
    const session = this.get(id);
    return new Promise((resolve) => {
      session.screen.write("", () => {
        resolve(this.readTail(session, lines));
      });
    });
  }

  private readTail(session: Session, lines: number): string[] {
    const buffer = session.screen.buffer.active;
    // Cursor movement does not erase content. Trim only the unused blank suffix.
    let end = buffer.length;
    while (
      end > 0 &&
      !buffer
        .getLine(end - 1)
        ?.translateToString(true)
        .trim()
    )
      end--;
    const result: string[] = [];
    for (let index = Math.max(0, end - lines); index < end; index++) {
      result.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return result;
  }

  private terminate(session: Session): void {
    // ConPTY closes a native handle: repeating a successful request can crash the host.
    // A throwing request remains retryable; Unix can safely resend graceful signals.
    if (process.platform === "win32" && session.terminationRequested) return;
    session.pty.kill();
    session.terminationRequested = true;
  }

  kill(id: string): void {
    const session = this.get(id);
    this.detach(id);
    this.sessions.delete(id);
    this.activity.remove(id);
    for (const subscription of session.subscriptions) subscription.dispose();
    try {
      if (!session.exited) this.terminate(session);
    } finally {
      session.screen.write("", () => {
        session.screen.dispose();
      });
    }
  }

  get hasPendingExits(): boolean {
    return this.pendingExits.size > 0;
  }

  /** The process must stay alive until native PTY exit callbacks have drained. */
  async waitForExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pendingExits.values()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Terminal shutdown timed out"));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.kill(id);
  }

  get runningCount(): number {
    return [...this.sessions.values()].filter((session) => !session.exited).length;
  }

  /** Stop one process while retaining its screen and capability for recovery. */
  async stop(id: string): Promise<void> {
    const session = this.get(id);
    if (!session.exited) await this.stopSession(session);
  }

  private async stopSession(session: Session): Promise<void> {
    if (session.paused) {
      session.pty.resume();
      session.paused = false;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(force);
        clearTimeout(deadline);
        subscription.dispose();
        if (error) reject(error);
        else resolve();
      };
      const subscription = session.pty.onExit(() => {
        finish();
      });
      const force = setTimeout(() => {
        try {
          // ConPTY kill already terminates the process tree and rejects signals.
          if (process.platform !== "win32") session.pty.kill("SIGKILL");
        } catch (error) {
          finish(new Error("Unable to stop terminal", { cause: error }));
        }
      }, 1000);
      const deadline = setTimeout(() => {
        finish(new Error("A terminal did not exit; try quitting again."));
      }, 5000);
      try {
        this.terminate(session);
      } catch (error) {
        finish(new Error("Unable to stop terminal", { cause: error }));
      }
    });
  }

  /** Keep exit listeners alive until every PTY has actually stopped. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      const results = await Promise.allSettled(
        [...this.pendingExits.keys()].map(async (session) => {
          await this.stopSession(session);
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      // Removed terminals may still have native exit callbacks in flight.
      await this.waitForExit();
      this.dispose();
    } catch (error) {
      this.shuttingDown = false;
      throw error;
    }
  }
}
