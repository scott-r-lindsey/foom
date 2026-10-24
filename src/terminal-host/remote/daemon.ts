import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { HostResponse } from "../../shared/terminal-host";
import type { RemoteRequest, RemoteResponse } from "../../shared/remote-host";
import {
  RemoteFrames,
  MAX_REMOTE_MESSAGE,
  remoteResponseFrames,
  remoteRequest,
  remoteResponse,
} from "../../shared/remote-host-protocol";
import { TerminalManager } from "../terminal-manager";
import { hostSocket } from "./private-path";

export const DETACHED_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Only remote account facts can choose the executable; never protocol input. */
export function remoteShell(shell = process.env["SHELL"], accountShell = () => userInfo().shell) {
  const valid = (path: string | null | undefined): path is string => {
    if (!path || !isAbsolute(path)) return false;
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (valid(shell)) return shell;
  try {
    const account = accountShell();
    if (valid(account)) return account;
  } catch {
    // Account lookup may be unavailable; the POSIX fallback remains local.
  }
  return "/bin/sh";
}

type Session = {
  connection?: Socket;
  exited?: number;
  reap?: ReturnType<typeof setTimeout>;
  removing?: Promise<void>;
};
/** One per-user daemon. Connections have authority over one shell, never hub control. */
export function serveHost(
  build: string,
  home = homedir(),
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
) {
  const path = hostSocket(home);
  const sessions = new Map<string, Session>();
  let shuttingDown = false;
  const sockets = new Set<Socket>();
  const outgoing = new WeakMap<Socket, { chain: Promise<void>; queued: number }>();
  const send = (
    socket: Socket,
    message: Exclude<RemoteResponse, { type: "fragment" }>,
    replay = false,
  ): Promise<void> => {
    if (!remoteResponse(message)) {
      socket.destroy();
      return Promise.resolve();
    }
    const state = outgoing.get(socket) ?? { chain: Promise.resolve(), queued: 0 };
    outgoing.set(socket, state);
    // Dispatch awaits each result and replay, so only one bounded reply is
    // retained at a time. The separate backlog cap applies to live updates.
    const cost =
      replay || message.type === "result" ? 0 : Buffer.byteLength(JSON.stringify(message));
    state.queued += cost;
    if (state.queued > 1024 * 1024 || socket.writableLength > 1024 * 1024) {
      socket.destroy();
      return Promise.resolve();
    }
    state.chain = state.chain
      .then(async () => {
        // One frame in flight. A large replay cannot fill the socket queue or
        // interleave live output/results; attach waits before accepting another replay.
        for (const frame of remoteResponseFrames(message)) {
          if (socket.destroyed) return;
          await new Promise<void>((resolve, reject) => {
            const closed = () => {
              reject(new Error("Remote disconnected"));
            };
            socket.once("close", closed);
            socket.write(frame, (error) => {
              socket.removeListener("close", closed);
              if (error) reject(error);
              else resolve();
            });
          });
        }
      })
      .catch(() => {
        socket.destroy();
      })
      .finally(() => {
        state.queued -= cost;
      });
    return state.chain;
  };
  const cancelReap = (session: Session) => {
    timers.clearTimeout(session.reap);
    delete session.reap;
  };
  const remove = (id: string, session: Session): Promise<void> => {
    if (session.removing) return session.removing;
    cancelReap(session);
    session.removing = Promise.resolve().then(async () => {
      try {
        await manager.stop(id);
      } finally {
        sessions.delete(id);
        manager.kill(id);
      }
    });
    return session.removing;
  };
  const reap = (id: string, session: Session) => {
    // stop can time out; remove still kills/disposes and releases the slot.
    void remove(id, session).catch(() => {});
  };
  const event = (message: HostResponse) => {
    if (message.type === "activity") return;
    const session = sessions.get(message.id);
    if (message.type === "exit" && session) session.exited = message.code;
    if (session?.connection) void send(session.connection, message);
    else if (message.type === "exit" && session && !shuttingDown) reap(message.id, session);
  };
  const manager = new TerminalManager((id, code) => {
    event({ type: "exit", id, code });
  });
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const frames = new RemoteFrames();
    let negotiated = false;
    let id: string | undefined;
    let queued = 0;
    let chain = Promise.resolve();
    const deadline = setTimeout(() => socket.destroy(), 10000);
    const dispatch = async (message: RemoteRequest) => {
      if (socket.destroyed) return;
      if (!negotiated) {
        if (message.type !== "hello" || message.build !== build)
          throw new Error("Host version mismatch");
        negotiated = true;
        clearTimeout(deadline);
        await send(socket, { type: "hello", build });
        return;
      }
      if (message.type === "hello") throw new Error("Repeated negotiation");
      if (message.type === "open") {
        if (id !== undefined) throw new Error("Already open");
        id = message.id;
        let session = sessions.get(id);
        if (!session) {
          if (sessions.size >= 32) throw new Error("Host session limit");
          // The remote chooses its own shell, HOME and environment. No hub
          // paths, startup files, environment values or credentials are copied.
          manager.create(
            {
              command: remoteShell(),
              args: ["-i", "-l"],
              cwd: home,
              cols: message.cols,
              rows: message.rows,
            },
            id,
          );
          session = {};
          sessions.set(id, session);
        }
        if (session.removing) throw new Error("Session expired");
        cancelReap(session);
        if (session.connection && session.connection !== socket) {
          manager.detach(id);
          session.connection.destroy();
        }
        session.connection = socket;
        await send(socket, { type: "result", id, request: message.request, lines: [] });
        return;
      }
      if (!id || message.id !== id || sessions.get(id)?.connection !== socket)
        throw new Error("Foreign session");
      let lines: string[] = [];
      let signaled: boolean | undefined;
      let screen: { title: string; cols: number; rows: number } | undefined;
      switch (message.type) {
        case "attach": {
          let snapshot = true;
          let replay = Promise.resolve();
          await manager.attach(
            message.id,
            (token, data) => {
              if (sessions.get(message.id)?.connection === socket) {
                const sent = send(
                  socket,
                  { type: "data", id: message.id, view: message.view, token, data },
                  snapshot,
                );
                if (snapshot) replay = sent;
                snapshot = false;
              }
            },
            true,
            (token, data) =>
              JSON.stringify({ type: "data", id: message.id, view: message.view, token, data })
                .length <= MAX_REMOTE_MESSAGE,
          );
          await replay;
          if (sessions.get(id)?.exited !== undefined)
            event({ type: "exit", id, code: sessions.get(id)?.exited ?? -1 });
          break;
        }
        case "detach":
          manager.detach(id);
          break;
        case "write":
          manager.write(id, message.data);
          break;
        case "resize":
          manager.resize(id, message.cols, message.rows);
          break;
        case "acknowledge":
          manager.acknowledge(id, message.token, message.count);
          break;
        case "theme":
          manager.setTheme(id, message.theme ?? message.dark);
          break;
        case "screen": {
          const result = await manager.screen(id);
          lines = result.lines;
          screen = result;
          break;
        }
        case "tail":
          lines = await manager.tail(id, message.lines);
          break;
        case "stop":
          signaled = await manager.stop(id);
          break;
        case "kill":
          {
            const session = sessions.get(id);
            if (session) await remove(id, session);
          }
          break;
      }
      await send(socket, {
        type: "result",
        request: message.request,
        id,
        lines,
        ...(signaled === undefined ? {} : { signaled }),
        ...screen,
      });
    };
    socket.on("data", (bytes: Buffer) => {
      try {
        frames.push(bytes, (value) => {
          if (!remoteRequest(value) || ++queued > 256) throw new Error("Invalid remote request");
          chain = chain.then(async () => {
            try {
              await dispatch(value);
            } catch {
              socket.destroy();
            } finally {
              queued--;
            }
          });
        });
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      const sessionId = id;
      if (sessionId && sessions.get(sessionId)?.connection === socket) {
        const session = sessions.get(sessionId);
        if (!session) return;
        delete session.connection;
        manager.detach(sessionId);
        if (session.exited !== undefined) reap(sessionId, session);
        else
          session.reap = timers.setTimeout(() => {
            reap(sessionId, session);
          }, DETACHED_SESSION_GRACE_MS);
      }
    });
  });
  // Never unlink a pre-existing socket: another version or a live daemon may own it.
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  server.listen(path, () => {
    chmodSync(path, 0o600);
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      if (closing) return closing;
      shuttingDown = true;
      closing = (async () => {
        // Revoke attachments before native shutdown disposes manager sessions;
        // a later socket-close callback must not address a disposed terminal.
        for (const [id, session] of sessions) {
          cancelReap(session);
          delete session.connection;
          manager.detach(id);
        }
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled(
          [...sessions.values()].flatMap((session) => (session.removing ? [session.removing] : [])),
        );
        await manager.shutdown();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            }),
          );
        // net.Server removes only the socket it successfully bound on close.
        // Never unlink here: another daemon may own a pre-existing/replaced path.
      })().catch((error: unknown) => {
        closing = undefined;
        shuttingDown = false;
        throw error;
      });
      return closing;
    },
  };
}
