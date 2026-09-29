import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Os from "node:os";
import { tmpdir, userInfo } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AgentService } from "../src/agents";
import type { TerminalSpec } from "../src/shared/desktop";

vi.mock("node:os", async (original) => {
  const os = await original<typeof Os>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});
let directory = "";
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "probes real executables and prepares launches without touching agent configs in a temporary HOME",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "foom-agents-"));
    const bin = join(directory, "bin with spaces");
    const home = join(directory, "home");
    await mkdir(bin);
    await mkdir(home);
    const shell = join(bin, "login-shell");
    await writeFile(shell, `#!/bin/sh\nprintf '\\000FOOM_PATH\\000%s\\000' '${bin}'\n`, {
      mode: 0o700,
    });
    vi.mocked(userInfo).mockReturnValue({ uid: 1, gid: 1, username: "test", homedir: home, shell });
    vi.stubEnv("HOME", home);
    for (const name of [".claude", ".codex", ".agents"]) {
      await mkdir(join(home, name));
      await writeFile(join(home, name, "settings.json"), '{"keep":"my configuration"}\n');
    }
    const executable = join(bin, "claude");
    await writeFile(
      executable,
      '#!/bin/sh\ncase "$1" in\n--version) echo "2.1.284 (Claude Code)";;\n--help) echo "--settings <file-or-json>";;\n*) exit 1;;\nesac\n',
      { mode: 0o700 },
    );
    const create = vi.fn((_spec: TerminalSpec) => "real-probe-terminal");
    const service = new AgentService(
      {
        listWorktrees: () =>
          Promise.resolve([
            {
              path: directory,
              managed: true,
              bare: false,
              prunable: false,
              locked: false,
              head: null,
              branch: "test",
            },
          ]),
      },
      { create },
      () =>
        Promise.resolve({
          claudeCommand: "foom-hook",
          codexCommand: ["foom-notify"],
          env: {},
          dispose() {},
        }),
    );
    const scan = await service.scan();
    expect(scan.agents[0]).toMatchObject({
      path: executable,
      version: "2.1.284 (Claude Code)",
      hooks: true,
    });
    expect(scan.agents[1]?.path).toBeNull();
    await service.launch({
      agent: "claude",
      repository: directory,
      worktree: directory,
      cols: 80,
      rows: 24,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ command: executable, cwd: directory }),
    );
    for (const name of [".claude", ".codex", ".agents"]) {
      expect(await readdir(join(home, name))).toEqual(["settings.json"]);
      expect(await readFile(join(home, name, "settings.json"), "utf8")).toBe(
        '{"keep":"my configuration"}\n',
      );
    }
    expect((await readdir(home)).sort()).toEqual([".agents", ".claude", ".codex"]);
    await chmod(executable, 0o600);
    expect((await service.scan()).agents[0]?.path).toBeNull();
    await chmod(executable, 0o700);
    expect((await service.scan()).agents[0]?.path).toBe(executable);
    service.dispose();
  },
);
