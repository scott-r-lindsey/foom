import { isSea } from "node:sea";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { serveHost } from "./daemon";
import { checkSocket, hostSocket } from "./private-path";

// Hash the SEA itself: identical application versions with different builds cannot
// silently attach to each other or replace a daemon with live sessions.
export function runHost(argv: readonly string[] = process.argv): void {
  const build = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  if (argv.length !== 3 || !["--daemon", "--connect"].includes(argv[2] ?? "")) {
    process.stderr.write("Usage: foom-host --daemon|--connect\n");
    process.exitCode = 2;
  } else if (argv[2] === "--daemon") {
    process.umask(0o077);
    const host = serveHost(build);
    host.server.once("error", () => {
      process.exitCode = 1;
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => {
        void host.close().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          },
        );
      });
  } else {
    const path = hostSocket(homedir());
    let started = false;
    let attempts = 0;
    const connect = () => {
      try {
        checkSocket(path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      const socket = createConnection(path);
      socket.once("connect", () => {
        try {
          checkSocket(path);
        } catch {
          socket.destroy();
          process.exitCode = 1;
          return;
        }
        process.stdin.pipe(socket);
        socket.pipe(process.stdout);
        process.stdin.once("end", () => socket.destroy());
        process.stdout.once("error", () => socket.destroy());
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (
          (error.code === "ENOENT" || (started && error.code === "ECONNREFUSED")) &&
          attempts++ < 100
        ) {
          if (!started) {
            started = true;
            const env = { ...process.env };
            delete env["NODE_OPTIONS"];
            const child = spawn(process.execPath, ["--daemon"], {
              detached: true,
              stdio: "ignore",
              env,
            });
            child.on("error", () => {
              process.exitCode = 1;
            });
            child.unref();
          }
          setTimeout(connect, 20);
        } else {
          process.stderr.write("Unable to connect to host daemon\n");
          process.exitCode = 1;
        }
      });
    };
    connect();
  }
}
if (isSea()) runHost();
