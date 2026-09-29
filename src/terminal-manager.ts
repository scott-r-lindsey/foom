import { randomUUID } from "node:crypto";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalSpec } from "./shared/desktop";

type View = { token: string; send: (token: string, data: string) => void };
type Session = {
  pty: IPty;
  screen: Terminal;
  serialize: SerializeAddon;
  subscriptions: IDisposable[];
  view?: View;
  pending: number;
  paused: boolean;
  exited: boolean;
  generation: number;
};

/** Main-owned state; no renderer is needed to consume PTY output. */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private shuttingDown = false;
  private readonly pendingExits = new Set<Promise<void>>();

  constructor(private readonly onExit: (id: string, code: number) => void) {}

  create(spec: TerminalSpec): string {
    if (this.shuttingDown) throw new Error("Terminals are shutting down");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(npm_|ELECTRON_)/i.test(key)) env[key] = value;
    }
    const pty = spawn(spec.command, [...spec.args], {
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
    const screen = new Terminal({
      cols: spec.cols,
      rows: spec.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    screen.loadAddon(serialize);
    const id = randomUUID();
    const session: Session = {
      pty,
      screen,
      serialize,
      subscriptions: [],
      pending: 0,
      paused: false,
      exited: false,
      generation: 0,
    };
    this.sessions.set(id, session);
    session.subscriptions = [
      // Main is the response owner, whether or not a renderer is attached.
      screen.onData((data) => {
        if (!session.exited) pty.write(data);
      }),
      pty.onData((data) => {
        screen.write(data, () => {
          if (this.sessions.has(id)) this.deliver(session, data);
        });
      }),
    ];
    let resolveExit: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.pendingExits.add(exited);
    // Keep this subscription after kill: killing a PTY only requests termination.
    const exitSubscription = pty.onExit(({ exitCode }) => {
      session.exited = true;
      this.pendingExits.delete(exited);
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
    if (session.pending > 262144 && !session.paused && !session.exited && !this.shuttingDown) {
      session.paused = true;
      session.pty.pause();
    }
    session.view.send(session.view.token, data);
  }

  write(id: string, data: string): void {
    const session = this.get(id);
    if (!session.exited) session.pty.write(data);
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
    await new Promise<void>((resolve) => {
      // A parser barrier makes the snapshot and subsequent live stream contiguous.
      session.screen.write("", () => {
        if (this.sessions.has(id) && generation === session.generation) {
          session.view = { token: randomUUID(), send };
          this.deliver(session, session.serialize.serialize());
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
    if (session.paused && !session.exited) session.pty.resume();
    session.paused = false;
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
    if (session.paused && session.pending < 65536) {
      session.paused = false;
      if (!session.exited) session.pty.resume();
    }
  }

  async tail(id: string, lines: number): Promise<string[]> {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
      throw new Error("Invalid tail length");
    const session = this.get(id);
    return new Promise((resolve) => {
      session.screen.write("", () => {
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
        resolve(result);
      });
    });
  }

  kill(id: string): void {
    const session = this.get(id);
    this.detach(id);
    this.sessions.delete(id);
    for (const subscription of session.subscriptions) subscription.dispose();
    if (!session.exited) session.pty.kill();
    session.screen.write("", () => {
      session.screen.dispose();
    });
  }

  get hasPendingExits(): boolean {
    return this.pendingExits.size > 0;
  }

  /** The process must stay alive until native PTY exit callbacks have drained. */
  async waitForExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pendingExits),
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

  /** Keep exit listeners alive until every PTY has actually stopped. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      const results = await Promise.allSettled(
        [...this.sessions.values()].map(async (session) => {
          if (session.exited) return;
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
              session.pty.kill();
            } catch (error) {
              finish(new Error("Unable to stop terminal", { cause: error }));
            }
          });
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
