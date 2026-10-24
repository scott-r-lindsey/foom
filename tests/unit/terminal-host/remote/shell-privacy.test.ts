import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { serveHost } from "../../../../src/terminal-host/remote/daemon";
import { RemoteFrames, remoteFrame } from "../../../../src/shared/remote-host-protocol";

test.skipIf(process.platform === "win32")(
  "the real spawned remote shell receives no terminal ID in argv, environment or cwd",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shell-privacy-")));
    const shell = join(root, "shell");
    const probe = join(root, "probe.cjs");
    const record = join(root, "record.json");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(shell, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)} "$@"\n`, {
      mode: 0o700,
    });
    await writeFile(
      probe,
      `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() })); setInterval(() => {}, 1000);`,
    );
    vi.stubEnv("SHELL", shell);
    vi.stubEnv("HOME", root);
    const host = serveHost("a".repeat(64), root);
    let socket;
    try {
      await once(host.server, "listening");
      socket = createConnection(join(root, ".foom-host/host.sock"));
      await once(socket, "connect");
      const messages: unknown[] = [];
      const frames = new RemoteFrames();
      socket.on("data", (bytes: Buffer) => {
        frames.push(bytes, (message) => {
          messages.push(message);
        });
      });
      socket.write(remoteFrame({ type: "hello", build: "a".repeat(64) }));
      await vi.waitFor(() => {
        expect(messages).toHaveLength(1);
      });
      const id = "private-terminal-capability-436d5c64";
      socket.write(remoteFrame({ type: "open", id, request: 1, cols: 80, rows: 24 }));
      await vi.waitFor(() => {
        expect(messages).toHaveLength(2);
      });
      let observed = "";
      await vi.waitFor(async () => {
        observed = await readFile(record, "utf8");
        expect(observed).not.toContain(id);
      });
      const value: unknown = JSON.parse(observed);
      expect(value).toMatchObject({
        args: ["-i", "-l"],
        env: { HOME: root, SHELL: shell },
        cwd: root,
      });
    } finally {
      socket?.destroy();
      await host.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
