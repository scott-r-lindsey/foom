import { legacyDaemon, endLegacyDaemon } from "./legacy";
import type { LegacyDaemon } from "./legacy";
import { RemoteImages } from "./image-files";
import { createHash, randomBytes } from "node:crypto";
import { imagePng, IMAGE_TIMEOUT_MS, imagePasteRecipient } from "../../shared/image-paste";
import {
  HOST_HANDSHAKE_TIMEOUT_MS,
  HOST_MANAGEMENT_TIMEOUT_MS,
  HOST_PREPARATION_TIMEOUT_MS,
} from "../../shared/registered-hosts";
import { readWorktreeProvenance } from "./worktree-provenance";
import { remoteCheckout, hostLoginEnvironment } from "./agent-discovery";
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
import type { RemoteRequest, RemoteResponse, RemoteSessionContext } from "../../shared/remote-host";
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
export const EXIT_TOMBSTONE_GRACE_MS = 24 * 60 * 60 * 1000;
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
type Tombstone = { code: number; expiry: Expiry; profile?: string };
type Session = {
  generation: string;
  connection?: Socket;
  profile?: string;
  context?: RemoteSessionContext;
  human?: boolean;
  checkout?: { repository: string; path: string; identity: string };
  imageOwner?: string;
  imagePaste?: boolean;
  imageUpload?: Promise<unknown>;
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
  let startImages: (() => void) | undefined;
  let failImages: ((error: unknown) => void) | undefined;
  const imageStartup = new Promise<void>((resolve, reject) => {
    startImages = resolve;
    failImages = reject;
  });
  const images = new RemoteImages(home, imageStartup);
  // A failed sweep disables image paste; existing terminal capabilities stay available.
  void images.ready.catch(() => {
    console.error("Image paste cleanup failed");
  });
  let imageBusy = false;
  const sessions = new Map<string, Session>();
  const worktrees = new Set<Session>();
  const removingWorktrees = new Set<string>();
  const tombstones = new Map<string, Tombstone>();
  let legacy: { id: string; generation: string; daemon: LegacyDaemon } | undefined;
  // Reservations outlive sockets: disconnected callers cannot accumulate work
  // or overlap a retry with a subprocess/cleanup that has not settled yet.
  const operations = new Map<AbortController, Promise<unknown>>();
  let mutating = false;
  const recipeSessions = new Set<string>();
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
    if (!stopping) recipeSessions.delete(id);
    if (!stopping) worktrees.delete(session);
    delete session.imageOwner;
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
    }, EXIT_TOMBSTONE_GRACE_MS);
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
        try {
          // Release the stopped PTY immediately; keep the daemon session reserved
          // until pending publication and private-file cleanup have settled.
          manager.kill(id);
          // Reconnects must observe the known exit even while files are closing.
          const code = session.exited;
          if (
            rememberExit &&
            !shuttingDown &&
            code !== undefined &&
            remoteResponse({ type: "exit", id, code })
          ) {
            const expiry = session.expiry ?? scheduleExpiry(id);
            if (!expiry.expired)
              tombstones.set(id, {
                code,
                expiry,
                ...(session.profile ? { profile: session.profile } : {}),
              });
            // Map insertion order is exit/disposal order; reads never renew it.
            for (const [oldId, old] of tombstones) {
              if (tombstones.size <= MAX_EXIT_TOMBSTONES) break;
              cancelExpiry(old.expiry);
              tombstones.delete(oldId);
            }
          } else cancelExpiry(session.expiry);
          await session.imageUpload?.catch(() => {});
          await images.close(id).catch(() => {
            console.error("Image paste cleanup failed");
          });
        } finally {
          // Disposal can suppress the native exit callback, including after a stop timeout.
          recipeSessions.delete(id);
          sessions.delete(id);
          worktrees.delete(session);
        }
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
      void (session.imageUpload ?? Promise.resolve())
        .finally(() => images.close(message.id))
        .catch(() => {
          console.error("Image paste cleanup failed");
        });
    }
    if (session?.connection) void send(session.connection, message);
    else if (message.type === "exit" && session && !shuttingDown) {
      session.expiry ??= scheduleExpiry(message.id);
      reap(message.id, session, true);
    }
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
      if (session.agent) {
        session.imageOwner = randomBytes(32).toString("hex");
      }
      pendingConnections.delete(socket);
      clearTimeout(deadline);
      if (session.agent && !session.human)
        await send(socket, {
          type: "agent-ready",
          id,
          ready: session.agent.ready,
          ...(session.imageOwner ? { imageOwner: session.imageOwner } : {}),
        });
      await send(socket, { type: "open-result", id, request, state: "live" });
      for (const signal of session.human ? [] : (session.hooks?.splice(0) ?? []))
        await send(socket, { type: "agent-hook", id, signal });
    };
    let queued = 0;
    let imageQueued = false;
    let chain = Promise.resolve();
    const cancellation = new AbortController();
    let deadline = setTimeout(() => socket.destroy(), HOST_HANDSHAKE_TIMEOUT_MS);
    const budget = (milliseconds: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        cancellation.abort();
        socket.destroy();
      }, milliseconds);
    };
    const disconnected = () => socket.destroyed || shuttingDown;
    const dispatch = async (message: RemoteRequest) => {
      if (disconnected()) return;
      if (!negotiated) {
        if (message.type !== "hello") throw new Error("Host version mismatch");
        if (
          message.build !== build &&
          sessions.size === 0 &&
          tombstones.size === 0 &&
          worktrees.size === 0 &&
          operations.size === 0 &&
          sockets.size === 1
        ) {
          // Set the shutdown gate synchronously: no connection can create a PTY
          // between the idle decision and listener close. Never unlink a socket.
          shuttingDown = true;
          await send(socket, { type: "upgrade", build });
          void close().catch(() => {});
          return;
        }
        negotiated = true;
        await send(socket, { type: "hello", build, compatible: 2, hostFacts: 1 });
        return;
      }
      if (message.type === "hello") throw new Error("Repeated negotiation");
      if (message.type === "inventory" || message.type === "end-sessions") {
        if (id !== undefined) throw new Error("Session already open");
        const mutation = message.type === "end-sessions";
        if (
          operations.size >= MAX_PENDING_CONNECTIONS ||
          (mutation && (mutating || recipeSessions.size > 0))
        )
          throw new Error("Management reserve unavailable");
        budget(HOST_MANAGEMENT_TIMEOUT_MS);
        if (mutation) mutating = true;
        const operation = (async () => {
          cancellation.signal.throwIfAborted();
          if (message.type === "inventory" && message.codeFolder) {
            const observed = await legacyDaemon(home, message.codeFolder, cancellation.signal);
            cancellation.signal.throwIfAborted();
            if (observed) {
              if (
                !legacy ||
                legacy.daemon.pid !== observed.pid ||
                legacy.daemon.started !== observed.started
              )
                legacy = {
                  id: `legacy-${randomBytes(16).toString("hex")}`,
                  generation: randomBytes(16).toString("hex"),
                  daemon: observed,
                };
              else legacy.daemon = observed;
            } else legacy = undefined;
          }
          if (message.type === "end-sessions") {
            // The confirmed IDs are a snapshot. Never end this profile's sessions,
            // or newly arrived sessions not present in the confirmation.
            if (
              message.ids.some(({ id, generation }) => {
                if (id === legacy?.id) return generation !== legacy.generation;
                const session = sessions.get(id);
                if (!session && id.startsWith("legacy-")) return true;
                return (
                  session &&
                  (session.profile === message.profile || session.generation !== generation)
                );
              })
            )
              throw new Error("Foreign cleanup refused");
            const confirmed = message.ids.map(({ id }) => ({
              id,
              session: sessions.get(id),
              legacy: id === legacy?.id ? legacy : undefined,
            }));
            for (const target of confirmed) {
              cancellation.signal.throwIfAborted();
              // Earlier stops yield to other connections. A replacement must be
              // confirmed again; the inventory below reports its new incarnation.
              if (target.legacy) {
                if (legacy !== target.legacy) continue;
                await endLegacyDaemon(target.legacy.daemon, cancellation.signal);
                if (legacy === target.legacy) legacy = undefined;
              } else if (target.session && sessions.get(target.id) === target.session) {
                await remove(target.id, target.session);
              }
            }
          }
          const live = [...sessions].filter(
            ([, session]) => session.exited === undefined && !session.removing,
          );
          cancellation.signal.throwIfAborted();
          const result: Extract<RemoteResponse, { type: "inventory-result" }> = {
            type: "inventory-result",
            own: live
              .filter(([, session]) => session.profile === message.profile)
              .map(([id, session]) => ({
                id,
                ...(session.context ? { context: session.context } : {}),
                ...(session.checkout ? { checkout: session.checkout } : {}),
              })),
            foreign: [
              ...live
                .filter(([, session]) => session.profile !== message.profile)
                .map(([id, session]) => ({ id, generation: session.generation })),
              ...(legacy
                ? [{ id: legacy.id, generation: legacy.generation, count: legacy.daemon.count }]
                : []),
            ],
          };
          return result;
        })();
        operations.set(cancellation, operation);
        try {
          await send(socket, await operation);
        } finally {
          operations.delete(cancellation);
          if (mutation) mutating = false;
          if (!disconnected()) budget(HOST_HANDSHAKE_TIMEOUT_MS);
        }
        return;
      }
      if (message.type === "image-put") {
        if (id !== undefined) throw new Error("Session already open");
        const session = sessions.get(message.id);
        const connection = session?.connection;
        const live = () =>
          !cancellation.signal.aborted &&
          !disconnected() &&
          session !== undefined &&
          session.agent !== undefined &&
          session.imagePaste === true &&
          session.exited === undefined &&
          !session.removing &&
          session.connection === connection &&
          connection !== undefined &&
          !connection.destroyed &&
          session.imageOwner === message.owner;
        const refusal = {
          type: "image-result",
          id: message.id,
          owner: message.owner,
          upload: message.upload,
          ok: false,
        } as const;
        if (!live() || !session || imageBusy || operations.size >= MAX_PENDING_CONNECTIONS) {
          await send(socket, refusal);
          return;
        }
        budget(IMAGE_TIMEOUT_MS);
        imageBusy = true;
        const operation = (async () => {
          const png = Buffer.from(message.data, "base64");
          if (
            png.length !== message.size ||
            png.toString("base64") !== message.data ||
            !imagePng(png) ||
            createHash("sha256").update(png).digest("hex") !== message.sha256
          )
            throw new Error("Image integrity refused");
          const path = await images.put(message.id, png, live);
          if (!live()) throw new Error("Image cancelled");
          await send(socket, { ...refusal, ok: true, path });
        })();
        session.imageUpload = operation;
        operations.set(cancellation, operation);
        try {
          await operation;
        } catch {
          await send(socket, refusal);
        } finally {
          if (session.imageUpload === operation) delete session.imageUpload;
          operations.delete(cancellation);
          imageBusy = false;
          if (!disconnected()) budget(HOST_HANDSHAKE_TIMEOUT_MS);
        }
        return;
      }
      if (message.type === "manage") {
        if (id !== undefined) throw new Error("Session already open");
        const mutation =
          (message.operation === "inspect" && !message.readOnly) || // Enrollment may create the approved folder.
          message.operation === "clone" ||
          message.operation === "create-worktree" ||
          message.operation === "remove-worktree";
        if (
          operations.size >= MAX_PENDING_CONNECTIONS ||
          (mutation && (mutating || recipeSessions.size > 0))
        ) {
          await send(socket, {
            type: "managed",
            result: { ok: false, reason: "checkout-refused" },
          });
          return;
        }
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
        budget(HOST_MANAGEMENT_TIMEOUT_MS);
        if (mutation) mutating = true;
        try {
          const operation = manageHost(
            message,
            [...sessions.values()].filter((entry) => entry.exited === undefined && !entry.removing)
              .length,
            remoteShell(),
            version,
            home,
            cancellation.signal,
          );
          operations.set(cancellation, operation);
          await send(socket, { type: "managed", result: await operation });
        } finally {
          if (removing !== undefined) removingWorktrees.delete(removing);
          operations.delete(cancellation);
          if (mutation) mutating = false;
          if (!disconnected()) budget(HOST_HANDSHAKE_TIMEOUT_MS);
        }
        return;
      }
      if (message.type === "agent-close" || message.type === "session-close") {
        if (id !== undefined) throw new Error("Already open");
        const session = sessions.get(message.id);
        const tombstone = tombstones.get(message.id);
        if (message.type === "session-close") {
          if (
            (session && session.profile !== message.profile) ||
            (tombstone && tombstone.profile !== message.profile)
          )
            throw new Error("Profile mismatch");
        } else if (session && !session.agent) throw new Error("Not an agent");
        if (session) await remove(message.id, session);
        cancelExpiry(tombstone?.expiry);
        tombstones.delete(message.id);
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
        if (session && session.profile !== message.profile) throw new Error("Profile mismatch");
        const tombstone = tombstones.get(id);
        if (message.type === "agent-open" && (session || tombstone))
          throw new Error("Agent launch ID already exists");
        if (
          (session?.removing && !tombstone) ||
          (!session && !tombstone && message.type === "open" && message.reattach)
        ) {
          await send(socket, { type: "open-result", id, request: message.request, state: "gone" });
          return;
        }
        if (tombstone) {
          if (tombstone.profile !== message.profile) throw new Error("Profile mismatch");
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
          if (!message.profile) throw new Error("Missing owning profile");
          if (sessions.size >= MAX_SESSIONS) throw new Error("Host session limit");
          const sessionId = id;
          session = {
            generation: randomBytes(16).toString("hex"),
            ...(message.profile ? { profile: message.profile } : {}),
            ...(message.context ? { context: message.context } : {}),
          };
          const owned = session;
          if (message.type === "agent-open") {
            if (removingWorktrees.has(message.spec.worktree))
              throw new Error("Worktree is being removed");
            if (operations.size >= MAX_PENDING_CONNECTIONS) throw new Error("Preparation limit");
            budget(HOST_PREPARATION_TIMEOUT_MS);
            owned.imagePaste = imagePasteRecipient(message.spec.agent);
            owned.worktree = message.spec.worktree;
            if (message.spec.checkoutIdentity)
              owned.checkout = {
                repository: message.spec.repository,
                path: message.spec.worktree,
                identity: message.spec.checkoutIdentity,
              };
            worktrees.add(owned);
            owned.hooks = [];
            try {
              const preparation = prepareRemoteAgent(
                message.spec,
                remoteShell(),
                home,
                (signal) => {
                  const reduced = { ...signal, terminalId: sessionId };
                  if (owned.exited !== undefined || owned.removing) return;
                  if (owned.human) return;
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
                      owned.human ||
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
                cancellation.signal,
                message.profile,
              );
              operations.set(cancellation, preparation);
              owned.agent = await preparation;
            } catch (error) {
              revoke(id, owned);
              throw error;
            } finally {
              operations.delete(cancellation);
            }
            if (disconnected()) {
              revoke(id, owned);
              return;
            }
            prepared = {
              session: owned,
              open: message,
              timer: setTimeout(() => socket.destroy(), HOST_PREPARATION_TIMEOUT_MS),
            };
            await send(socket, { type: "agent-prepared", id });
            return;
          }
          try {
            if (message.recipe) {
              if (mutating || recipeSessions.size > 0) throw new Error("Host mutation busy");
              recipeSessions.add(id);
            }
            const checkout = message.checkout;
            if (checkout) {
              if (
                removingWorktrees.has(checkout.path) ||
                operations.size >= MAX_PENDING_CONNECTIONS
              )
                throw new Error("Checkout unavailable");
              budget(HOST_PREPARATION_TIMEOUT_MS);
              owned.worktree = checkout.path;
              owned.checkout = checkout;
              worktrees.add(owned);
              const preparation = (async () => {
                const owner = await readWorktreeProvenance(checkout.path);
                if (
                  !owner ||
                  owner.profile !== message.profile ||
                  owner.repository !== checkout.repository
                )
                  throw new LaunchFailure("remote_worktree_unavailable");
                const env = {
                  ...(await hostLoginEnvironment(remoteShell(), home, cancellation.signal)),
                  GIT_NO_REPLACE_OBJECTS: "1",
                  GIT_GRAFT_FILE: "/dev/null",
                };
                const identity = await remoteCheckout(
                  checkout.repository,
                  checkout.path,
                  env,
                  cancellation.signal,
                );
                if (createHash("sha256").update(identity).digest("hex") !== checkout.identity)
                  throw new LaunchFailure("remote_worktree_unavailable");
              })();
              operations.set(cancellation, preparation);
              try {
                await preparation;
              } finally {
                operations.delete(cancellation);
              }
              if (disconnected() || isShuttingDown()) throw new Error("Launch cancelled");
            }
            manager.create(
              owned.agent
                ? { ...owned.agent.spec, cols: message.cols, rows: message.rows }
                : {
                    command: message.recipe ? process.execPath : remoteShell(),
                    args: message.recipe
                      ? [
                          "--recipe",
                          message.recipe.tool,
                          message.recipe.action,
                          message.recipe.distro,
                          message.recipe.digest,
                        ]
                      : ["-i", "-l"],
                    cwd: message.checkout?.path ?? home,
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
        session.human = message.type === "open" && message.human === true;
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
          // Large image bodies must not accumulate behind this connection's chain.
          if (value.type === "image-put") {
            if (imageQueued) throw new Error("Image request already pending");
            imageQueued = true;
          }
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
              if (value.type === "image-put") imageQueued = false;
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
      cancellation.abort();
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
        delete session.imageOwner;
        for (const [key, call] of calls)
          if (call.socket === socket) {
            clearTimeout(call.timer);
            calls.delete(key);
            call.resolve({ type: "error", error: "unavailable" });
          }
        manager.detach(sessionId);

        if (session.exited !== undefined) {
          session.expiry ??= scheduleExpiry(sessionId);
          reap(sessionId, session, true);
        }
      }
    });
  });
  // Never unlink a pre-existing socket: another version or a live daemon may own it.
  server.on("error", (error) => {
    failImages?.(error);
    for (const socket of sockets) socket.destroy();
  });
  server.listen(path, () => {
    chmodSync(path, 0o600);
    startImages?.();
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    shuttingDown = true;
    closing = (async () => {
      // Revoke attachments before native shutdown disposes manager sessions;
      // a later socket-close callback must not address a disposed terminal.
      for (const [id, session] of sessions) {
        cancelExpiry(session.expiry);
        revoke(id, session);
        delete session.connection;
        delete session.imageOwner;
        manager.detach(id);
      }
      for (const operation of operations.keys()) operation.abort();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...operations.values()]);
      await Promise.allSettled(
        [...sessions.values()].flatMap((session) => (session.removing ? [session.removing] : [])),
      );
      for (const tombstone of tombstones.values()) cancelExpiry(tombstone.expiry);
      tombstones.clear();
      await manager.shutdown();
      await Promise.all([...sessions.keys()].map((id) => images.close(id)));
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
  }
  return { server, close };
}
