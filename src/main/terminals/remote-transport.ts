import type { HostManagement, HostResult, HostFailure } from "../../shared/registered-hosts.d";
import {
  HOST_MANAGEMENT_TIMEOUT_MS,
  HOST_PREPARATION_TIMEOUT_MS,
} from "../../shared/registered-hosts";
import { LaunchFailure } from "../../shared/launch-failure";
import { remoteControlResult } from "../../shared/remote-agent-protocol";
import { ApplicationError } from "../../shared/application-errors";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostRequest } from "../../shared/terminal-host";
import type { RemoteTarget, RemoteRequest } from "../../shared/remote-host";
import {
  RemoteFrames,
  RemoteMessages,
  remoteFrame,
  remoteHost,
  remoteRequest,
  remoteResponse,
  REMOTE_GONE_EXIT_CODE,
} from "../../shared/remote-host-protocol";
import {
  UnsupportedRemotePlatform,
  bootstrapArguments,
  selectHostArtifact,
  sshEnvironment,
} from "./remote-bootstrap";

type Connection = {
  child: ChildProcess;
  dead: boolean;
  exited: boolean;
  closed: boolean;
  deadline: ReturnType<typeof setTimeout> | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
};

/** Utility-client-shaped adapter. It never exposes SSH/daemon text as diagnostics. */
export class RemoteTransport extends EventEmitter {
  private connection: Connection | undefined;
  private readonly cancellation = new AbortController();
  managementFailure: HostFailure = "unreachable";
  private artifactUnavailable = false;
  launchFailure: LaunchFailure | undefined;

  /** Only a local sealed-metadata rejection may select this trusted reason. */
  get failureReason(): "remote-host-unavailable" | undefined {
    return this.artifactUnavailable ? "remote-host-unavailable" : undefined;
  }

  private artifact: Awaited<ReturnType<typeof selectHostArtifact>> | undefined;
  private closed = false;
  private ready = false;
  private opened = false;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private session: Extract<HostRequest, { type: "create" }> | undefined;
  private attachment: Extract<HostRequest, { type: "attach" }> | undefined;
  private dimensions: Extract<HostRequest, { type: "resize" }> | undefined;
  private theme: Extract<HostRequest, { type: "theme" }> | undefined;
  private pending = new Map<number, string>();
  private internal = Number.MAX_SAFE_INTEGER;
  private restoring: number | undefined;
  private restoration = new Set<number>();

  constructor(
    private readonly target: RemoteTarget,
    expectedVersion: string,
    private readonly management?: HostManagement,
  ) {
    super();
    if (!remoteHost(target.host)) throw new Error("Invalid SSH host");
    if (target.agent)
      target.agent.activate = () => {
        if (!this.session || !this.ready || this.closed)
          throw new Error("Remote launch unavailable");
        this.send({ type: "agent-activate", id: this.session.id });
      };
    void selectHostArtifact(target, expectedVersion, undefined, undefined, this.cancellation.signal)
      .then((artifact) => {
        if (this.closed) return;
        if (artifact.version !== expectedVersion)
          throw new Error("Host application version mismatch");
        this.artifact = artifact;
        this.connect();
      })
      .catch((error: unknown) => {
        this.launchFailure =
          error instanceof LaunchFailure ? error : new LaunchFailure("remote_artifact_mismatch");
        this.managementFailure =
          error instanceof UnsupportedRemotePlatform ? "unsupported" : "unreachable";
        this.artifactUnavailable =
          error instanceof ApplicationError && error.code === "remote-host-unavailable";
        this.kill();
      });
  }
  private openRequest(request: number, reattach: boolean): RemoteRequest {
    const session = this.session;
    if (!session) throw new Error("Remote session unavailable");
    if (this.target.cleanup) return { type: "agent-close", id: session.id, request };
    return this.target.agent && !reattach
      ? {
          type: "agent-open",
          id: session.id,
          request,
          cols: session.spec.cols,
          rows: session.spec.rows,
          spec: this.target.agent.spec,
        }
      : {
          type: "open",
          id: session.id,
          request,
          cols: session.spec.cols,
          rows: session.spec.rows,
          reattach,
        };
  }
  private send(message: RemoteRequest): void {
    const connection = this.connection;
    try {
      if (!remoteRequest(message) || !connection?.child.stdin?.writable)
        throw new Error("Remote unavailable");
      connection.child.stdin.write(remoteFrame(message));
    } catch {
      if (connection) this.retireConnection(connection, "failure");
      throw new Error("Remote unavailable");
    }
  }
  private retireConnection(
    connection: Connection,
    reason: "failure" | "exit" | "close" | "dispose",
  ): void {
    if (connection.dead) return;
    // Detach synchronously, before signalling or notifying callers. Neither a
    // buffered response nor a reentrant/late process event can revive this stream.
    connection.dead = true;
    clearTimeout(connection.deadline);
    this.connection = undefined;
    this.ready = false;
    this.restoring = undefined;
    this.restoration.clear();
    const pending = [...this.pending];
    this.pending.clear();
    const signal = (name: NodeJS.Signals) => {
      try {
        connection.child.kill(name);
      } catch {
        // A failed graceful signal must not prevent escalation or retry progress.
      }
    };
    if (!connection.closed) {
      connection.grace = setTimeout(() => {
        connection.grace = undefined;
        if (!connection.exited) signal("SIGKILL");
        // Descendants can hold SSH's pipes open even after its process exits.
        connection.child.stdin?.destroy();
        connection.child.stdout?.destroy();
        connection.child.stderr?.destroy();
      }, 1000);
      if (!connection.exited) signal("SIGTERM");
    }
    if (!this.opened && reason !== "dispose")
      this.launchFailure ??= new LaunchFailure("remote_host_unreachable");
    for (const [request, id] of pending) this.emit("message", { type: "error", request, id });
    if (reason === "dispose" || this.closed) return;
    // Reserve one of five reconnect attempts exactly once, independently of close.
    if (!this.opened || this.retries >= 5) {
      this.launchFailure ??= new LaunchFailure("remote_host_unreachable");
      this.kill();
      return;
    }
    this.retries++;
    this.timer = setTimeout(() => {
      try {
        this.connect();
      } catch {
        this.kill();
      }
    }, 1000);
  }
  private connect(): void {
    const artifact = this.artifact;
    if (!artifact || this.closed) return;
    // No shell option, no SSH agent/key copying, no inherited Foom/control env.
    const env = sshEnvironment();
    const child = spawn(
      "ssh",
      bootstrapArguments(
        this.target.host,
        artifact.version,
        artifact.sha256,
        artifact.bytes.length,
        artifact.upload.length,
        artifact.platform,
        artifact.arch,
      ),
      { env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    const connection: Connection = {
      child,
      dead: false,
      exited: false,
      closed: false,
      deadline: undefined,
      grace: undefined,
    };
    this.connection = connection;
    let header = Buffer.alloc(0);
    let bootstrapped = false;
    let uploading = false;
    const frames = new RemoteFrames();
    const responses = new RemoteMessages();
    const agentCalls = new Set<number>();
    let hookEvents = 0;
    let agentReady = false;
    let agentPrepared = false;
    let deadline = setTimeout(() => {
      this.retireConnection(connection, "failure");
    }, 120000);
    connection.deadline = deadline;
    const receive = (bytes: Buffer) => {
      if (connection.dead || this.connection !== connection || this.closed) return;
      try {
        if (!bootstrapped) {
          header = Buffer.concat([header, bytes]);
          for (;;) {
            const end = header.indexOf(10);
            if (end < 0) {
              if (header.length > 32) throw new Error("Invalid bootstrap");
              return;
            }
            const line = header.subarray(0, end).toString("ascii");
            header = header.subarray(end + 1);
            if (line === "FOOM-UPLOAD" && !uploading) {
              uploading = true;
              child.stdin.write(artifact.upload);
              continue;
            }
            if (line !== "FOOM-READY") throw new Error("Invalid bootstrap");
            bootstrapped = true;
            this.send({ type: "hello", build: artifact.sha256 });
            bytes = header;
            header = Buffer.alloc(0);
            break;
          }
        }
        frames.push(bytes, (wire) => {
          if (connection.dead || this.closed) return;
          if (!remoteResponse(wire)) throw new Error("Invalid remote response");
          if (wire.type === "fragment" && (!this.ready || wire.id !== this.session?.id))
            throw new Error("Foreign remote fragment");
          const value = responses.push(wire);
          if (!value) return;
          if (!this.ready) {
            if (value.type !== "hello" || value.build !== artifact.sha256)
              throw new Error("Host version mismatch");
            // Reconnect's deadline covers open, state restoration and the entire
            // replay. Internal requests have no TerminalHostClient request timer.
            if (!this.opened) {
              clearTimeout(deadline);
              if (this.management || this.target.agent) {
                deadline = setTimeout(
                  () => {
                    this.retireConnection(connection, "failure");
                  },
                  this.management ? HOST_MANAGEMENT_TIMEOUT_MS : HOST_PREPARATION_TIMEOUT_MS,
                );
                connection.deadline = deadline;
              }
            }
            this.ready = true;
            if (this.management) this.send(this.management);
            const session = this.session;
            if (session) {
              const request = this.opened ? --this.internal : session.request;
              if (this.opened) {
                this.restoring = request;
              }
              this.send(this.openRequest(request, this.opened));
            }
            return;
          }
          if (value.type === "managed") {
            if (!this.management) throw new Error("Unexpected management result");
            clearTimeout(deadline);
            this.emit("managed", value.result);
            this.kill();
            return;
          }
          if (this.management) throw new Error("Unexpected management response");
          if (value.type === "agent-failed") {
            if (!this.target.agent || value.id !== this.session?.id || this.opened)
              throw new Error("Unexpected failure");
            this.launchFailure = new LaunchFailure(value.reason);
            this.retireConnection(connection, "failure");
            return;
          }
          if (value.type === "activity") {
            if (!this.session || value.entries.some((entry) => entry.id !== this.session?.id))
              throw new Error("Foreign activity");
            this.emit("message", value);
            return;
          }
          if (value.type === "hello" || !this.session || value.id !== this.session.id)
            throw new Error("Foreign remote response");
          if (
            value.type === "agent-prepared" ||
            value.type === "agent-ready" ||
            value.type === "agent-hook" ||
            value.type === "agent-call"
          ) {
            const agent = this.target.agent;
            if (!agent) throw new Error("Unexpected remote agent event");
            if (value.type === "agent-prepared") {
              if (this.opened || agentPrepared) throw new Error("Unexpected remote preparation");
              agentPrepared = true;
              void agent
                .authorize()
                .then(() => {
                  if (!connection.dead && !this.closed && this.connection === connection) {
                    agent.start();
                    this.send({ type: "agent-start", id: value.id });
                  }
                })
                .catch(() => {
                  this.retireConnection(connection, "failure");
                });
            } else if (value.type === "agent-ready") {
              if (!this.opened && !agentPrepared)
                throw new Error("Remote spawn was not authorized");
              if (agentReady) throw new Error("Repeated remote agent metadata");
              agentReady = true;
              agent.ready(value.ready);
            } else if (value.type === "agent-hook") {
              if (!agentReady || ++hookEvents > 256)
                throw new Error("Remote hook backlog exceeded");
              void Promise.resolve(agent.hook(value.signal))
                .catch(() => {
                  this.retireConnection(connection, "failure");
                })
                .finally(() => {
                  hookEvents--;
                });
            } else {
              if (!agentReady || agentCalls.size >= 4 || agentCalls.has(value.call))
                throw new Error("Remote relay backlog exceeded");
              agentCalls.add(value.call);
              void agent
                .call(value.method, value.params)
                .then((result) => {
                  if (connection.dead || this.closed || this.connection !== connection) return;
                  if (!remoteControlResult(result)) throw new Error("Invalid relay result");
                  this.send({ type: "agent-reply", id: value.id, call: value.call, result });
                })
                .catch(() => {
                  this.retireConnection(connection, "failure");
                })
                .finally(() => {
                  agentCalls.delete(value.call);
                });
            }
            return;
          }
          if (value.type === "open-result") {
            if (value.request === this.restoring) {
              if (value.state !== "live") {
                // A definitive terminal outcome preserves the last displayed
                // screen and cannot consume/restart a transport retry allowance.
                this.kill();
                this.emit("message", {
                  type: "exit",
                  id: value.id,
                  code: value.state === "exited" ? value.code : REMOTE_GONE_EXIT_CODE,
                });
                return;
              }
              this.restoring = undefined;
              for (const command of [this.theme, this.dimensions, this.attachment])
                if (command) {
                  const request = --this.internal;
                  this.restoration.add(request);
                  this.send({ ...command, request });
                }
              return;
            }
            if (
              this.opened ||
              value.request !== this.session.request ||
              !this.pending.delete(value.request) ||
              value.state !== "live"
            )
              throw new Error("Unexpected open result");
            clearTimeout(deadline);
            this.opened = true;
            if (this.theme) this.send({ ...this.theme, request: --this.internal });
            this.emit("message", {
              type: "result",
              id: value.id,
              request: value.request,
              lines: [],
            });
            return;
          }
          if (value.type === "result" || value.type === "error") {
            if (value.request === this.restoring) throw new Error("Invalid open result");
            if (this.restoration.delete(value.request)) {
              if (value.type === "error") throw new Error("View restoration failed");
              // Attach's result follows the entire replay, including all fragments.
              if (this.restoration.size === 0) {
                clearTimeout(deadline);
                this.retries = 0;
              }
              return;
            }
            if (!this.opened && value.request === this.session.request && !this.target.cleanup)
              throw new Error("Invalid initial open result");
            if (value.request >= this.internal) return;
            if (!this.pending.delete(value.request)) return;
          }
          if (value.type === "data") {
            if (value.view !== this.attachment?.view) return;
          }
          this.emit("message", value);
        });
      } catch {
        this.retireConnection(connection, "failure");
      }
    };
    child.stdout.on("data", receive);
    child.stdin.on("error", () => {
      this.retireConnection(connection, "failure");
    });
    // stderr is deliberately drained without logging: a remote host controls it.
    child.stderr.resume();
    child.once("error", () => {
      this.retireConnection(connection, "failure");
    });
    child.once("exit", () => {
      connection.exited = true;
      this.retireConnection(connection, "exit");
    });
    child.once("close", () => {
      connection.exited = true;
      connection.closed = true;
      clearTimeout(connection.grace);
      this.retireConnection(connection, "close");
    });
  }

  postMessage(message: HostRequest | "shutdown"): void {
    if (message === "shutdown") {
      this.kill();
      return;
    }
    if (this.closed) throw new Error("Remote transport closed");
    if (message.type === "shutdown") {
      this.emit("message", { type: "result", id: message.id, request: message.request, lines: [] });
      this.kill();
      return;
    }
    if (message.type === "create") {
      if (this.session) throw new Error("Remote transport already owns a session");
      this.session = message;
      this.theme = {
        type: "theme",
        id: message.id,
        request: message.request,
        dark: message.dark ?? false,
        ...(message.theme ? { theme: message.theme } : {}),
      };
    } else {
      if (message.id !== this.session?.id || (message.type === "child-input" && !this.target.agent))
        throw new Error("Unsupported remote operation");
      if (message.type === "attach") this.attachment = message;
      if (message.type === "detach") this.attachment = undefined;
      if (message.type === "resize") this.dimensions = message;
      if (message.type === "theme") this.theme = message;
      if (!this.ready || this.restoring !== undefined) {
        this.emit("message", { type: "error", id: message.id, request: message.request });
        return;
      }
    }
    this.pending.set(message.request, message.id);
    if (this.ready)
      this.send(message.type === "create" ? this.openRequest(message.request, false) : message);
  }
  kill(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.cancellation.abort();
    clearTimeout(this.timer);
    if (this.connection) this.retireConnection(this.connection, "dispose");
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

/** One bounded management connection, with no PTY or terminal ID. */
export function remoteManagement(
  target: RemoteTarget,
  version: string,
  request: HostManagement,
  signal?: AbortSignal,
): Promise<HostResult> {
  return new Promise((resolve) => {
    const transport = new RemoteTransport(target, version, request);
    const cancel = () => {
      transport.kill();
    };
    const finish = (result: HostResult) => {
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    transport.once("managed", finish);
    transport.once("exit", () => {
      finish({
        ok: false,
        reason: transport.failureReason ? "artifact-unavailable" : transport.managementFailure,
      });
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
