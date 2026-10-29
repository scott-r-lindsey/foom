import { manageHost } from "./management";
import { version } from "../../../package.json";
import { LaunchFailure } from "../../shared/launch-failure";
import { record } from "../../shared/remote-agent-protocol";
import { prepareRemoteAgent } from "./agent-launch";
import type { RemoteControlResult } from "../../shared/remote-agent";
import type { HookSignal } from "../../shared/hooks";
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

export const MAX_EXIT_TOMBSTONES = 64;
export const DETACHED_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_PENDING_CONNECTIONS = 4;

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

type Expiry = { timer?: ReturnType<typeof setTimeout>; expired?: boolean };
type Tombstone = { code: number; expiry: Expiry };
type Session = {
  connection?: Socket;
  exited?: number;
  expiry?: Expiry;
  removing?: Promise<void>;
  worktree?: string;
  agent?: Awaited<ReturnType<typeof prepareRemoteAgent>>;
  hooks?: HookSignal[];
};
/** One per-user daemon. Connections have authority over one shell, never hub control. */
export function serveHost(
  build: string,
  home = homedir(),
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
) {
  const path = hostSocket(home);
  const sessions = new Map<string, Session>();
  const worktrees = new Set<Session>();
  const removingWorktrees = new Set<string>();
  const tombstones = new Map<string, Tombstone>();
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  let sequence = 0;
  const calls = new Map<
    number,
    {
      id: string;
      socket: Socket;
      resolve(value: RemoteControlResult): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const revoke = (id: string, session: Session, stopping = false) => {
    if (!stopping) worktrees.delete(session);
    session.agent?.endpoint.dispose();
    for (const [key, call] of calls)
      if (call.id === id) {
        clearTimeout(call.timer);
        calls.delete(key);
        call.resolve({ type: "error", error: "unavailable" });
      }
  };
  const sockets = new Set<Socket>();
  const pendingConnections = new Set<Socket>();
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
  const cancelExpiry = (expiry: Expiry | undefined) => {
    timers.clearTimeout(expiry?.timer);
  };
  const scheduleExpiry = (id: string): Expiry => {
    const expiry: Expiry = {};
    expiry.timer = timers.setTimeout(() => {
      expiry.expired = true;
      if (tombstones.get(id)?.expiry === expiry) tombstones.delete(id);
      const session = sessions.get(id);
      if (session?.expiry === expiry) reap(id, session);
    }, DETACHED_SESSION_GRACE_MS);
    return expiry;
  };
  const remove = (id: string, session: Session, rememberExit = false): Promise<void> => {
    if (session.removing) return session.removing;
    // Revoke credentials immediately, but reserve the checkout until the PTY stops.
    revoke(id, session, true);
    if (!rememberExit) cancelExpiry(session.expiry);
    session.removing = Promise.resolve().then(async () => {
      try {
        await manager.stop(id);
      } finally {
        sessions.delete(id);
        manager.kill(id);
        worktrees.delete(session);
        const code = session.exited;
        if (
          rememberExit &&
          !shuttingDown &&
          code !== undefined &&
          remoteResponse({ type: "exit", id, code })
        ) {
          const expiry = session.expiry ?? scheduleExpiry(id);
          if (!expiry.expired) tombstones.set(id, { code, expiry });
          // Map insertion order is exit/disposal order; reads never renew it.
          for (const [oldId, old] of tombstones) {
            if (tombstones.size <= MAX_EXIT_TOMBSTONES) break;
            cancelExpiry(old.expiry);
            tombstones.delete(oldId);
          }
        } else cancelExpiry(session.expiry);
      }
    });
    return session.removing;
  };
  const reap = (id: string, session: Session, rememberExit = false) => {
    // stop can time out; remove still kills/disposes and releases the live slot.
    void remove(id, session, rememberExit).catch(() => {});
  };
  const event = (message: HostResponse) => {
    if (message.type === "activity") return;
    const session = sessions.get(message.id);
    if (message.type === "exit" && session) {
      session.exited = message.code;
      revoke(message.id, session);
    }
    if (session?.connection) void send(session.connection, message);
    else if (message.type === "exit" && session && !shuttingDown) reap(message.id, session, true);
  };
  const manager = new TerminalManager(
    (id, code) => {
      event({ type: "exit", id, code });
    },
    {
      onOutput: (id) => {
        event({ type: "output", id });
      },
      onQuiet: (id) => {
        event({ type: "quiet", id });
      },
      onEvidence: (id, evidence) => {
        event({ type: "evidence", id, evidence });
      },
      onActivity: (entries) => {
        for (const entry of entries) {
          const connection = sessions.get(entry.id)?.connection;
          if (connection) void send(connection, { type: "activity", entries: [entry] });
        }
      },
    },
  );
  const server = createServer((socket) => {
    if (
      sockets.size >= MAX_SESSIONS + MAX_PENDING_CONNECTIONS ||
      pendingConnections.size >= MAX_PENDING_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    pendingConnections.add(socket);
    const frames = new RemoteFrames();
    let negotiated = false;
    let id: string | undefined;
    let prepared:
      | {
          session: Session;
          open: Extract<RemoteRequest, { type: "agent-open" }>;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    const opened = async (session: Session, id: string, request: number) => {
      cancelExpiry(session.expiry);
      delete session.expiry;
      if (session.connection && session.connection !== socket) {
        manager.detach(id);
        session.connection.destroy();
      }
      session.connection = socket;
      pendingConnections.delete(socket);
      clearTimeout(deadline);
      if (session.agent)
        await send(socket, { type: "agent-ready", id, ready: session.agent.ready });
      await send(socket, { type: "open-result", id, request, state: "live" });
      for (const signal of session.hooks?.splice(0) ?? [])
        await send(socket, { type: "agent-hook", id, signal });
    };
    let queued = 0;
    let chain = Promise.resolve();
    const deadline = setTimeout(() => socket.destroy(), 10000);
    const disconnected = () => socket.destroyed || shuttingDown;
    const dispatch = async (message: RemoteRequest) => {
      if (disconnected()) return;
      if (!negotiated) {
        if (message.type !== "hello" || message.build !== build)
          throw new Error("Host version mismatch");
        negotiated = true;
        await send(socket, { type: "hello", build });
        return;
      }
      if (message.type === "hello") throw new Error("Repeated negotiation");
      if (message.type === "manage") {
        if (id !== undefined) throw new Error("Session already open");
        const removing = message.operation === "remove-worktree" ? message.path : undefined;
        if (
          removing !== undefined &&
          (removingWorktrees.has(removing) ||
            [...worktrees].some((entry) => entry.worktree === removing))
        ) {
          await send(socket, {
            type: "managed",
            result: { ok: false, reason: "checkout-refused" },
          });
          return;
        }
        if (removing !== undefined) removingWorktrees.add(removing);
        try {
          await send(socket, {
            type: "managed",
            result: await manageHost(
              message,
              [...sessions.values()].filter(
                (entry) => entry.exited === undefined && !entry.removing,
              ).length,
              remoteShell(),
              version,
              home,
            ),
          });
        } finally {
          if (removing !== undefined) removingWorktrees.delete(removing);
        }
        return;
      }
      if (message.type === "agent-close") {
        if (id !== undefined) throw new Error("Already open");
        const session = sessions.get(message.id);
        if (session && !session.agent) throw new Error("Not an agent");
        if (session) await remove(message.id, session);
        await send(socket, { type: "result", id: message.id, request: message.request, lines: [] });
        return;
      }
      if (message.type === "agent-start") {
        const pending = prepared;
        if (
          !pending ||
          !id ||
          message.id !== id ||
          sessions.has(id) ||
          sessions.size >= MAX_SESSIONS ||
          shuttingDown
        )
          throw new Error("Invalid agent start");
        const agent = pending.session.agent;
        if (!agent) throw new Error("Missing agent preparation");
        await agent.validate();
        if (disconnected() || prepared !== pending || isShuttingDown())
          throw new Error("Launch cancelled");
        manager.create({ ...agent.spec, cols: pending.open.cols, rows: pending.open.rows }, id);
        clearTimeout(pending.timer);
        prepared = undefined;
        sessions.set(id, pending.session);
        await opened(pending.session, id, pending.open.request);
        return;
      }
      if (message.type === "open" || message.type === "agent-open") {
        if (id !== undefined) throw new Error("Already open");
        id = message.id;
        let session = sessions.get(id);
        const tombstone = tombstones.get(id);
        if (message.type === "agent-open" && (session || tombstone))
          throw new Error("Agent launch ID already exists");
        if (
          session?.removing ||
          (!session && !tombstone && message.type === "open" && message.reattach)
        ) {
          await send(socket, { type: "open-result", id, request: message.request, state: "gone" });
          return;
        }
        if (tombstone) {
          await send(socket, {
            type: "open-result",
            id,
            request: message.request,
            state: "exited",
            code: tombstone.code,
          });
          return;
        }
        if (!session) {
          if (sessions.size >= MAX_SESSIONS) throw new Error("Host session limit");
          const sessionId = id;
          session = {};
          const owned = session;
          if (message.type === "agent-open") {
            if (removingWorktrees.has(message.spec.worktree))
              throw new Error("Worktree is being removed");
            owned.worktree = message.spec.worktree;
            worktrees.add(owned);
            owned.hooks = [];
            try {
              owned.agent = await prepareRemoteAgent(
                message.spec,
                remoteShell(),
                home,
                (signal) => {
                  const reduced = { ...signal, terminalId: sessionId };
                  if (owned.exited !== undefined || owned.removing) return;
                  if (owned.connection)
                    void send(owned.connection, {
                      type: "agent-hook",
                      id: sessionId,
                      signal: reduced,
                    });
                  else {
                    owned.hooks?.push(reduced);
                    if ((owned.hooks?.length ?? 0) > 64) owned.hooks?.shift();
                  }
                },
                (method, params) =>
                  new Promise<RemoteControlResult>((resolve) => {
                    const connection = owned.connection;
                    if (
                      !connection ||
                      connection.destroyed ||
                      !record(params) ||
                      owned.exited !== undefined ||
                      owned.removing
                    ) {
                      resolve({ type: "error", error: "unavailable" });
                      return;
                    }
                    const call = ++sequence;
                    const timer = setTimeout(() => {
                      calls.delete(call);
                      resolve({ type: "error", error: "unavailable" });
                    }, 10000);
                    calls.set(call, { id: sessionId, socket: connection, resolve, timer });
                    void send(connection, {
                      type: "agent-call",
                      id: sessionId,
                      call,
                      method,
                      params,
                    });
                  }),
              );
            } catch (error) {
              revoke(id, owned);
              throw error;
            }
            if (disconnected()) {
              revoke(id, owned);
              return;
            }
            prepared = {
              session: owned,
              open: message,
              timer: setTimeout(() => socket.destroy(), 10000),
            };
            await send(socket, { type: "agent-prepared", id });
            return;
          }
          try {
            manager.create(
              owned.agent
                ? { ...owned.agent.spec, cols: message.cols, rows: message.rows }
                : {
                    command: remoteShell(),
                    args: ["-i", "-l"],
                    cwd: home,
                    cols: message.cols,
                    rows: message.rows,
                  },
              id,
            );
          } catch (error) {
            revoke(id, owned);
            throw error;
          }
          sessions.set(id, owned);
        }
        await opened(session, id, message.request);
        return;
      }
      if (!id || message.id !== id || sessions.get(id)?.connection !== socket)
        throw new Error("Foreign session");
      if (message.type === "agent-activate") {
        const agent = sessions.get(id)?.agent;
        if (!agent) throw new Error("Not an agent");
        agent.endpoint.activate();
        return;
      }
      if (message.type === "agent-reply") {
        const call = calls.get(message.call);
        if (!call || call.id !== id || call.socket !== socket)
          throw new Error("Foreign relay response");
        clearTimeout(call.timer);
        calls.delete(message.call);
        call.resolve(message.result);
        return;
      }
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
        case "child-input":
          if (!sessions.get(id)?.agent) throw new Error("Not an agent");
          manager.childInput(id, message.input);
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
            } catch (error) {
              if (value.type === "agent-open" || value.type === "agent-start")
                await send(socket, {
                  type: "agent-failed",
                  id: value.id,
                  reason:
                    error instanceof LaunchFailure
                      ? error.reason
                      : value.type === "agent-open"
                        ? "remote_prepare_refused"
                        : "remote_start_refused",
                });
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
      if (prepared) {
        clearTimeout(prepared.timer);
        revoke(prepared.open.id, prepared.session);
        prepared = undefined;
      }
      sockets.delete(socket);
      pendingConnections.delete(socket);
      const sessionId = id;
      if (sessionId && sessions.get(sessionId)?.connection === socket) {
        const session = sessions.get(sessionId);
        if (!session) return;
        delete session.connection;
        for (const [key, call] of calls)
          if (call.socket === socket) {
            clearTimeout(call.timer);
            calls.delete(key);
            call.resolve({ type: "error", error: "unavailable" });
          }
        manager.detach(sessionId);
        session.expiry = scheduleExpiry(sessionId);
        if (session.exited !== undefined) reap(sessionId, session, true);
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
          cancelExpiry(session.expiry);
          revoke(id, session);
          delete session.connection;
          manager.detach(id);
        }
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled(
          [...sessions.values()].flatMap((session) => (session.removing ? [session.removing] : [])),
        );
        for (const tombstone of tombstones.values()) cancelExpiry(tombstone.expiry);
        tombstones.clear();
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
