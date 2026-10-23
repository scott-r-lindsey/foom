import { chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import type { HostResponse } from "../../shared/terminal-host";
import type { RemoteRequest, RemoteResponse } from "../../shared/remote-host";
import {
  RemoteFrames,
  remoteFrame,
  remoteRequest,
  remoteResponse,
} from "../../shared/remote-host-protocol";
import { TerminalManager } from "../terminal-manager";
import { hostSocket } from "./private-path";

type Session = { connection?: Socket; exited?: number };
/** One per-user daemon. Connections have authority over one shell, never hub control. */
export function serveHost(build: string, home = homedir()) {
  const path = hostSocket(home);
  const sessions = new Map<string, Session>();
  const sockets = new Set<Socket>();
  const send = (socket: Socket, message: RemoteResponse) => {
    if (!remoteResponse(message)) {
      socket.destroy();
      return;
    }
    try {
      // A slow/disconnected hub cannot retain unbounded output in the daemon.
      if (socket.writableLength > 1024 * 1024) {
        socket.destroy();
        return;
      }
      socket.write(remoteFrame(message));
    } catch {
      socket.destroy();
    }
  };
  const event = (message: HostResponse) => {
    if (message.type === "activity") return;
    const session = sessions.get(message.id);
    if (message.type === "exit" && session) session.exited = message.code;
    if (session?.connection) send(session.connection, message);
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
        send(socket, { type: "hello", build });
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
            { command: "/bin/sh", args: ["-i"], cwd: home, cols: message.cols, rows: message.rows },
            id,
          );
          session = {};
          sessions.set(id, session);
        }
        if (session.connection && session.connection !== socket) {
          manager.detach(id);
          session.connection.destroy();
        }
        session.connection = socket;
        send(socket, { type: "result", id, request: message.request, lines: [] });
        return;
      }
      if (!id || message.id !== id || sessions.get(id)?.connection !== socket)
        throw new Error("Foreign session");
      let lines: string[] = [];
      let signaled: boolean | undefined;
      let screen: { title: string; cols: number; rows: number } | undefined;
      switch (message.type) {
        case "attach":
          await manager.attach(
            message.id,
            (token, data) => {
              if (sessions.get(message.id)?.connection === socket)
                send(socket, { type: "data", id: message.id, view: message.view, token, data });
            },
            true,
          );
          if (sessions.get(id)?.exited !== undefined)
            event({ type: "exit", id, code: sessions.get(id)?.exited ?? -1 });
          break;
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
          await manager.stop(id);
          manager.kill(id);
          sessions.delete(id);
          break;
      }
      send(socket, {
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
      if (id && sessions.get(id)?.connection === socket) {
        delete sessions.get(id)?.connection;
        manager.detach(id);
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
      closing = (async () => {
        // Revoke attachments before native shutdown disposes manager sessions;
        // a later socket-close callback must not address a disposed terminal.
        for (const [id, session] of sessions) {
          delete session.connection;
          manager.detach(id);
        }
        for (const socket of sockets) socket.destroy();
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
        throw error;
      });
      return closing;
    },
  };
}
