import { readLoginShell } from "../login-shell";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, rm } from "node:fs/promises";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostKeyPrompt } from "../../node-common/ssh-askpass";
import type { PlainDialogContent, DialogOutcome } from "../../shared/confirmation";
import { hostAlias } from "../../shared/registered-hosts";
import { sshArguments, sshEnvironment } from "../terminals/remote-bootstrap";

export const askpassExecutable = join(__dirname, "../../console/foom").replace(
  /app\.asar(?=[/\\])/u,
  "app.asar.unpacked",
);

export async function askpassSupported(
  executable = askpassExecutable,
  signal?: AbortSignal,
): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    await access(executable, constants.X_OK);
    const options: Parameters<typeof readLoginShell>[2] = {
      env: { ...sshEnvironment(), LC_ALL: "C" },
      timeout: 5000,
      maxBuffer: 16384,
      encoding: "utf8",
      cwd: tmpdir(),
      ...(signal ? { signal } : {}),
    };
    const version = await readLoginShell("ssh", ["-V"], options);
    const match = /^OpenSSH_(\d+)\.(\d+)(?:p\d+)?(?:[, _]|$)/u.exec(
      version.stderr || version.stdout,
    );
    if (!match || Number(match[1]) < 8 || (Number(match[1]) === 8 && Number(match[2]) < 4))
      return false;
    await readLoginShell(executable, ["ssh-askpass", "--probe"], options);
    return true;
  } catch {
    return false;
  }
}

/** Only OpenSSH resolves user-owned aliases/configuration. Foom never opens ~/.ssh. */
export function configuredHost(output: string): { host: string; port: number } | undefined {
  const fields = (name: string) =>
    output
      .split("\n")
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const [hostname] = fields("hostname");
  const [port] = fields("port");
  const aliases = fields("hostkeyalias");
  if (
    fields("hostname").length !== 1 ||
    fields("port").length !== 1 ||
    aliases.length > 1 ||
    !hostname ||
    !/^[a-zA-Z0-9_.:-]+$/u.test(hostname) ||
    !port ||
    !/^\d{1,5}$/u.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    return undefined;
  const alias = aliases[0];
  if (alias !== undefined && !/^[a-zA-Z0-9_.:[\]-]+$/u.test(alias)) return undefined;
  const number = Number(port);
  const name = hostname.toLowerCase();
  const target = alias ?? (number === 22 ? name : `[${name}]:${String(number)}`);
  return target.length <= 200 ? { host: target, port: number } : undefined;
}

export type HostKeyTrustFailure =
  | "trust-not-eligible"
  | "invalid-alias"
  | "ssh-config-failed"
  | "ssh-config-invalid"
  | "socket-path-too-long"
  | "askpass-prompt-rejected"
  | "prompt-host-mismatch"
  | "ssh-exited-without-prompt"
  | "trust-timeout"
  | "ssh-start-failed"
  | "dialog-unavailable"
  | "trust-unavailable";

/** One detached SSH run, one authenticated local socket, one explicit answer. */
export async function trustHostKey(
  host: string,
  confirm: (content: PlainDialogContent, signal: AbortSignal) => Promise<DialogOutcome>,
  signal: AbortSignal,
  executable = askpassExecutable,
  report: (reason: HostKeyTrustFailure) => void = () => undefined,
): Promise<boolean> {
  const fail = (reason: HostKeyTrustFailure) => {
    report(reason);
    return false;
  };
  const cancelled = () => signal.aborted;
  if (cancelled()) return false;
  if (!hostAlias(host)) return fail("invalid-alias");
  if (process.platform === "win32") return fail("trust-unavailable");
  const env = { ...sshEnvironment(), LC_ALL: "C" };
  const config = await readLoginShell("ssh", ["-G", ...sshArguments(host)], {
    env,
    timeout: 5000,
    maxBuffer: 65536,
    signal,
    encoding: "utf8",
    cwd: tmpdir(),
  }).catch(() => undefined);
  const expected = config && configuredHost(config.stdout);
  if (cancelled()) return false;
  if (!config) return fail("ssh-config-failed");
  if (!expected) return fail("ssh-config-invalid");
  const directory = mkdtempSync(join(tmpdir(), "fk-"));
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const ended = () => lifetime.aborted;
  const sockets = new Set<Socket>();
  const server = createServer();
  let active = true;
  const answerState = { asked: false, accepted: false, declined: false };
  const failure: { reason: HostKeyTrustFailure | undefined } = { reason: undefined };
  const token = randomBytes(32).toString("hex");
  // will-quit disposal is synchronous: revoke and remove files before returning.
  const revoke = () => {
    active = false;
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      console.warn("Unable to remove SSH confirmation files");
    }
  };
  lifetime.addEventListener("abort", revoke, { once: true });
  try {
    if (ended()) return false;
    await chmod(directory, 0o700);
    const socketPath = join(directory, "s");
    if (socketPath.length > 100) return fail("socket-path-too-long");
    server.on("connection", (socket) => {
      if (!active || sockets.size >= 4) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      socket.setTimeout(120000, () => socket.destroy());
      let data = "";
      socket.on("data", (bytes: Buffer) => {
        data += bytes.toString("utf8");
        if (Buffer.byteLength(data) > 8192) {
          socket.destroy();
          return;
        }
        if (!data.endsWith("\n")) return;
        socket.pause();
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          socket.destroy();
          return;
        }
        if (
          !active ||
          lifetime.aborted ||
          answerState.asked ||
          typeof value !== "object" ||
          value === null ||
          Object.keys(value).length !== 2 ||
          !("token" in value) ||
          value.token !== token ||
          ((!("prompt" in value) || typeof value.prompt !== "string") &&
            (!("rejected" in value) || value.rejected !== true))
        ) {
          socket.destroy();
          return;
        }
        if (!("prompt" in value) || typeof value.prompt !== "string") {
          failure.reason ??= "askpass-prompt-rejected";
          socket.destroy();
          return;
        }
        const parsed = hostKeyPrompt(value.prompt);
        const key = hostKeyPrompt(value.prompt, expected);
        if (!key) {
          failure.reason ??= parsed ? "prompt-host-mismatch" : "askpass-prompt-rejected";
          socket.destroy();
          return;
        }
        failure.reason = undefined;
        answerState.asked = true;
        void confirm(
          {
            title: "Trust host key?",
            accept: "Trust host key",
            glyph: "shield",
            subject: host,
            detail:
              "Compare this fingerprint with a trusted source before accepting. OpenSSH will save this key in known_hosts.",
            facts: [
              { label: "Host", value: key.host, mono: true },
              { label: "Key type", value: key.type, mono: true },
              { label: "Fingerprint", value: key.fingerprint, mono: true },
            ],
          },
          lifetime,
        ).then(
          (answer) => {
            if (!active || lifetime.aborted || socket.destroyed) return;
            answerState.accepted = answer === "accepted";
            answerState.declined = answer === "declined" || answer === "cancelled";
            if (answer === "unavailable") failure.reason = "dialog-unavailable";
            socket.end(answerState.accepted ? "yes\n" : "no\n");
            if (!answerState.accepted) controller.abort();
          },
          () => {
            failure.reason ??= "dialog-unavailable";
            controller.abort();
          },
        );
      });
    });
    if (ended()) return false;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    if (ended()) return false;
    const args = sshArguments(host).map((arg) => (arg === "BatchMode=yes" ? "BatchMode=no" : arg));
    args.splice(
      1,
      0,
      "-n",
      ...[
        "StrictHostKeyChecking=ask",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "FingerprintHash=sha256",
        "VisualHostKey=no",
        "VerifyHostKeyDNS=no",
        "UpdateHostKeys=no",
        "ControlMaster=no",
        "ControlPath=none",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
        "RequestTTY=no",
      ].flatMap((option) => ["-o", option]),
    );
    await new Promise<void>((resolve) => {
      const child = spawn("ssh", [...args, "true"], {
        env: {
          ...env,
          SSH_ASKPASS: executable,
          SSH_ASKPASS_REQUIRE: "force",
          FOOM_ASKPASS_TOKEN: token,
          FOOM_ASKPASS_SOCKET: socketPath,
        },
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      const kill = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      };
      const timer = setTimeout(() => {
        failure.reason ??= "trust-timeout";
        controller.abort();
      }, 120000);
      lifetime.addEventListener("abort", kill, { once: true });
      if (lifetime.aborted) kill();
      child.on("exit", kill);
      child.on("error", () => {
        failure.reason ??= "ssh-start-failed";
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        lifetime.removeEventListener("abort", kill);
        resolve();
      });
    });
    if (cancelled() || answerState.declined) return false;
    if (answerState.accepted && !failure.reason) return true;
    return fail(
      failure.reason ?? (answerState.asked ? "dialog-unavailable" : "ssh-exited-without-prompt"),
    );
  } finally {
    active = false;
    controller.abort();
    lifetime.removeEventListener("abort", revoke);
    revoke();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
