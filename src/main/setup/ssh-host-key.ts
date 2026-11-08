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
import type { DialogContent } from "../../shared/confirmation";
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
export function configuredHost(output: string): string | undefined {
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
  const target = alias ?? (port === "22" ? hostname : `[${hostname}]:${port}`);
  return target.length <= 200 ? target : undefined;
}

/** One detached SSH run, one authenticated local socket, one explicit answer. */
export async function trustHostKey(
  host: string,
  confirm: (content: DialogContent, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
  executable = askpassExecutable,
): Promise<boolean> {
  const cancelled = () => signal.aborted;
  if (!hostAlias(host) || cancelled() || process.platform === "win32") return false;
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
  if (!expected || cancelled()) return false;
  const directory = mkdtempSync(join(tmpdir(), "fk-"));
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const ended = () => lifetime.aborted;
  const sockets = new Set<Socket>();
  const server = createServer();
  let active = true;
  let asked = false;
  const answerState = { accepted: false };
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
    if (socketPath.length > 100) return false;
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
          asked ||
          typeof value !== "object" ||
          value === null ||
          Object.keys(value).length !== 2 ||
          !("token" in value) ||
          value.token !== token ||
          !("prompt" in value) ||
          typeof value.prompt !== "string"
        ) {
          socket.destroy();
          return;
        }
        const key = hostKeyPrompt(value.prompt, expected);
        if (!key) {
          socket.destroy();
          return;
        }
        asked = true;
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
            answerState.accepted = answer;
            socket.end(answer ? "yes\n" : "no\n");
            if (!answer) controller.abort();
          },
          () => {
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
        controller.abort();
      }, 120000);
      lifetime.addEventListener("abort", kill, { once: true });
      if (lifetime.aborted) kill();
      child.on("exit", kill);
      child.on("error", () => {
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        lifetime.removeEventListener("abort", kill);
        resolve();
      });
    });
    return answerState.accepted && !cancelled();
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
