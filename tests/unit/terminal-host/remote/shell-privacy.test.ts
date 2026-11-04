import { once } from "node:events";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { serveHost } from "../../../../src/terminal-host/remote/daemon";
import { RemoteFrames, remoteFrame } from "../../../../src/shared/remote-host-protocol";

test.skipIf(process.platform === "win32").each([
  { inherited: 0o002, startup: "", expected: 0o002 },
  { inherited: 0o027, startup: "", expected: 0o027 },
  { inherited: 0o002, startup: "umask 022\n", expected: 0o022 },
])(
  "the real remote shell keeps capabilities private and applies host mask $inherited then startup $startup",
  async ({ inherited, startup, expected }) => {
    const root = join(await realpath(tmpdir()), "rs");
    await mkdir(root, { mode: 0o700 });
    const shell = join(root, "shell");
    const probe = join(root, "probe.cjs");
    const record = join(root, "record.json");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      shell,
      `#!/bin/sh\n${startup}exec ${quote(process.execPath)} ${quote(probe)} "$@"\n`,
      {
        mode: 0o700,
      },
    );
    await writeFile(
      probe,
      `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() })); setInterval(() => {}, 1000);`,
    );
    vi.stubEnv("SHELL", shell);
    vi.stubEnv("HOME", root);
    const host = serveHost("a".repeat(64), inherited, root);
    let socket;
    try {
      await once(host.server, "listening");
      socket = createConnection(join(root, ".foom-host/host-v2.sock"));
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
      socket.write(
        remoteFrame({
          type: "open",
          profile: "9".repeat(32),
          reattach: false,
          id,
          request: 1,
          cols: 80,
          rows: 24,
        }),
      );
      await vi.waitFor(() => {
        expect(messages).toHaveLength(2);
      });
      let observed = "";
      await vi.waitFor(async () => {
        observed = await readFile(record, "utf8");
        expect(observed).not.toContain(id);
        expect(observed).not.toContain("9".repeat(32));
      });
      expect((await stat(record)).mode & 0o777).toBe(0o666 & ~expected);
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
