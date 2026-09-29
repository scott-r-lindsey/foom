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
  parserPending: number;
  parserBlocked: boolean;
  viewBlocked: boolean;
  exited: boolean;
  generation: number;
};

/** Utility-process state; no renderer is needed to consume PTY output. */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly onExit: (id: string, code: number) => void) {}

  create(spec: TerminalSpec, id: string = randomUUID()): string {
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
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Foom" },
    });
    const screen = new Terminal({
      cols: spec.cols,
      rows: spec.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    screen.loadAddon(serialize);
    const session: Session = {
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
      generation: 0,
    };
    this.sessions.set(id, session);
    session.subscriptions = [
      // The host is the response owner, whether or not a renderer is attached.
      screen.onData((data) => {
        if (!session.exited) pty.write(data);
      }),
      pty.onData((data) => {
        session.parserPending += data.length;
        if (session.parserPending > 262144) session.parserBlocked = true;
        this.updateFlow(session);
        screen.write(data, () => {
          if (!this.sessions.has(id)) return;
          session.parserPending -= data.length;
          if (session.parserPending < 65536) session.parserBlocked = false;
          this.deliver(session, data);
          this.updateFlow(session);
        });
      }),
      pty.onExit(({ exitCode }) => {
        session.exited = true;
        // Preserve the final screen, and report exit after queued output has parsed.
        screen.write("", () => {
          if (this.sessions.has(id)) this.onExit(id, exitCode);
        });
      }),
    ];
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
    const blocked = session.parserBlocked || session.viewBlocked;
    if (session.exited || session.paused === blocked) return;
    session.paused = blocked;
    if (blocked) session.pty.pause();
    else session.pty.resume();
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

  dispose(): void {
    for (const id of this.sessions.keys()) this.kill(id);
  }
}
