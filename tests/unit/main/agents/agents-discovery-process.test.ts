import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof os>()),
  userInfo: vi.fn(() => ({ shell: null })),
  homedir: vi.fn(),
}));

const run = promisify(execFile);

it.skipIf(process.platform === "win32").each(["timeout", "version", "stdout", "stderr", "exit"])(
  "finishes discovery and removes stubborn CLI descendants on %s",
  async (mode) => {
    const directory = await mkdtemp(join(os.tmpdir(), "foom-discovery-"));
    vi.mocked(os.homedir).mockReturnValue(directory);
    vi.stubEnv("PATH", directory);
    const cli = resolve("tests/fixtures/discovery/cli.js");
    for (const [name, behavior] of [
      ["claude", "healthy"],
      ["codex", mode],
    ] as const) {
      // Pass fixture-only arguments without consulting any user configuration.
      await writeFile(
        join(directory, name),
        `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(directory)}, ${JSON.stringify(behavior)}); require(${JSON.stringify(cli)});\n`,
        { mode: 0o700 },
      );
    }
    const service = new AgentService(
      { listWorktrees: vi.fn(), launchIdentity: vi.fn() },
      { create: vi.fn() },
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const scan = service.scan();
    const pids = async () =>
      (await readFile(join(directory, "pids"), "utf8")).trim().split("\n").map(Number);
    try {
      const result = await Promise.race([
        scan,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            reject(new Error("Discovery did not settle"));
          }, 6500);
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(
        mode === "timeout" || mode === "version" ? 6500 : 4000,
      );
      expect(result.agents.find((agent) => agent.id === "claude")).toMatchObject({
        version: "2.1.284",
        hooks: true,
      });
      expect(result.agents.find((agent) => agent.id === "codex")?.path).toBe(
        join(directory, "codex"),
      );
      const recorded = await pids();
      expect(recorded).toHaveLength(2);
      const { stdout } = await run("/bin/ps", ["-axo", "pid=,stat="], {
        env: { PATH: directory },
      });
      const live = stdout
        .trim()
        .split("\n")
        .filter((line) => {
          const [pid, state] = line.trim().split(/\s+/u);
          // Orphans may remain as dead zombies until the OS reaps them.
          return recorded.includes(Number(pid)) && !state?.startsWith("Z");
        });
      expect(live).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      for (const pid of await pids().catch(() => [])) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already reaped by the bounded reader.
        }
      }
      await scan;
      service.dispose();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
