import { spawn } from "node:child_process";
import { HookReceiver } from "../src/hook-receiver";
import { hookAdapter } from "../src/hook-adapters";
import type { HookSignal } from "../src/shared/hooks";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Os from "node:os";
import { tmpdir, userInfo } from "node:os";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
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
    const signals: HookSignal[] = [];
    const receiver = await HookReceiver.listen((signal) => signals.push(signal));
    onTestFinished(() => receiver.close());
    const launch = receiver.register("real-probe-terminal", "claude");
    const adapter = join(directory, "observer.sh");
    await writeFile(adapter, hookAdapter("claude", "posix").source, { mode: 0o600 });
    const claudeCommand = `sh '${adapter}'`;
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
          claudeCommand,
          codexCommand: ["foom-notify"],
          env: launch.env,
          dispose: () => {
            launch.revoke();
          },
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
    try {
      const spec = create.mock.calls[0]?.[0];
      const settings: unknown = JSON.parse(spec?.args[1] ?? "null");
      const hook = [{ hooks: [{ type: "command", command: claudeCommand }] }];
      expect(settings).toEqual({
        hooks: { Stop: hook, PermissionRequest: hook, Notification: hook },
      });
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn("sh", [adapter], {
            env: { ...process.env, ...launch.env },
            stdio: "pipe",
            timeout: 8000,
          });
          let output = "";
          child.stdout.on("data", (data: Buffer) => {
            output += data.toString();
          });
          child.stderr.on("data", (data: Buffer) => {
            output += data.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => {
            resolve({ code, output });
          });
          child.stdin.end(
            JSON.stringify({
              session_id: "synthetic-session",
              hook_event_name: "PermissionRequest",
              tool_input: { command: "untrusted data" },
            }),
          );
        },
      );
      expect(result).toEqual({ code: 0, output: "" });
      expect(signals).toEqual([
        {
          terminalId: "real-probe-terminal",
          action: "needs_input",
          signal: "claude:PermissionRequest",
        },
      ]);
    } finally {
      service.dispose();
      await receiver.close();
    }
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
