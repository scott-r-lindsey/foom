import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostRequest } from "../../shared/terminal-host";
import type { RemoteTarget, RemoteRequest } from "../../shared/remote-host";
import {
  RemoteFrames,
  remoteFrame,
  remoteHost,
  remoteRequest,
  remoteResponse,
} from "../../shared/remote-host-protocol";
import { bootstrapArguments, hostArtifact } from "./remote-bootstrap";

/** Utility-client-shaped adapter. It never exposes SSH/daemon text as diagnostics. */
export class RemoteTransport extends EventEmitter {
  private child: ChildProcess | undefined;
  private artifact: Awaited<ReturnType<typeof hostArtifact>> | undefined;
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

  constructor(
    private readonly target: RemoteTarget,
    expectedVersion: string,
  ) {
    super();
    if (!remoteHost(target.host)) throw new Error("Invalid SSH host");
    void hostArtifact(target.artifact)
      .then((artifact) => {
        if (this.closed) return;
        if (artifact.version !== expectedVersion)
          throw new Error("Host application version mismatch");
        this.artifact = artifact;
        this.connect();
      })
      .catch(() => this.kill());
  }
  private send(message: RemoteRequest): void {
    if (!remoteRequest(message) || !this.child?.stdin?.writable)
      throw new Error("Remote unavailable");
    this.child.stdin.write(remoteFrame(message));
  }
  private connect(): void {
    const artifact = this.artifact;
    if (!artifact || this.closed) return;
    // No shell option, no SSH agent/key copying, no inherited Foom/control env.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "USERPROFILE",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "SSH_AUTH_SOCK",
    ]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(
      "ssh",
      bootstrapArguments(
        this.target.host,
        artifact.version,
        artifact.sha256,
        artifact.bytes.length,
      ),
      { env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    let header = Buffer.alloc(0);
    let bootstrapped = false;
    let uploading = false;
    const frames = new RemoteFrames();
    const deadline = setTimeout(() => child.kill(), 120000);
    const receive = (bytes: Buffer) => {
      if (this.child !== child || this.closed) return;
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
              child.stdin.write(artifact.bytes);
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
        frames.push(bytes, (value) => {
          if (!remoteResponse(value)) throw new Error("Invalid remote response");
          if (!this.ready) {
            if (value.type !== "hello" || value.build !== artifact.sha256)
              throw new Error("Host version mismatch");
            clearTimeout(deadline);
            this.ready = true;
            const session = this.session;
            if (session) {
              const request = this.opened ? --this.internal : session.request;
              if (this.opened) {
                this.restoring = request;
              }
              this.send({
                type: "open",
                id: session.id,
                request,
                cols: session.spec.cols,
                rows: session.spec.rows,
              });
            }
            return;
          }
          if (
            value.type === "hello" ||
            value.type === "activity" ||
            !this.session ||
            value.id !== this.session.id
          )
            throw new Error("Foreign remote response");
          if (value.type === "result" || value.type === "error") {
            if (value.request === this.restoring) {
              if (value.type === "error") throw new Error("Reattach failed");
              this.restoring = undefined;
              this.retries = 0;
              for (const command of [this.theme, this.dimensions, this.attachment])
                if (command) this.send({ ...command, request: --this.internal });
              return;
            }
            if (value.request >= this.internal) return;
            if (!this.pending.delete(value.request)) return;
            if (value.request === this.session.request && value.type === "result") {
              this.opened = true;
              if (this.theme) this.send({ ...this.theme, request: --this.internal });
            }
          }
          if (value.type === "data") {
            if (value.view !== this.attachment?.view) return;
          }
          this.emit("message", value);
        });
      } catch {
        child.kill();
      }
    };
    child.stdout.on("data", receive);
    child.stdin.on("error", () => child.kill());
    // stderr is deliberately drained without logging: a remote host controls it.
    child.stderr.resume();
    child.once("error", () => child.kill());
    child.once("close", () => {
      clearTimeout(deadline);
      if (this.child !== child || this.closed) return;
      this.child = undefined;
      this.ready = false;
      for (const [request, id] of this.pending)
        this.emit("message", { type: "error", request, id });
      this.pending.clear();
      if (!this.opened || this.retries++ >= 5) {
        this.kill();
        return;
      }
      this.timer = setTimeout(() => {
        this.connect();
      }, 1000);
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
      if (message.id !== this.session?.id || message.type === "child-input")
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
      this.send(
        message.type === "create"
          ? {
              type: "open",
              id: message.id,
              request: message.request,
              cols: message.spec.cols,
              rows: message.spec.rows,
            }
          : message,
      );
  }
  kill(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}
