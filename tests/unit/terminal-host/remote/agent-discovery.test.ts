import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gitSync } from "../../../helpers/git.js";
import {
  hostEnvironment,
  hostProbe,
  hostDiscovery,
  remoteCheckout,
} from "../../../../src/terminal-host/remote/agent-discovery";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import claude from "../../../../src/shared/bundled-agents/claude.json";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ad-")));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function script(name: string, source: string) {
  const file = join(root, name);
  await writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return file;
}
test.skipIf(process.platform === "win32")(
  "discovery runs only fixed remote probes against executable absolute PATH entries and its fixture login shell",
  async () => {
    vi.stubEnv("FOOM_CONTROL_TOKEN", "not inherited");
    vi.stubEnv("NODE_OPTIONS", "not inherited");
    vi.stubEnv("GIT_DIR", "not inherited");
    vi.stubEnv("CLAUDECODE", "not inherited");
    expect(hostEnvironment()).not.toHaveProperty("FOOM_CONTROL_TOKEN");
    expect(hostEnvironment()).not.toHaveProperty("GIT_DIR");
    const shell = await script(
      "shell",
      "process.stdout.write('\\0FOOM_PATH\\0' + process.env.PATH + '\\0')",
    );
    const cli = await script(
      "claude",
      "const arg=process.argv[2]; if(arg==='--version') console.log('2.1.296 (Claude Code)'); else if(arg==='--help') console.log('--settings --mcp-config'); else process.exit(3)",
    );
    const other = join(root, "other");
    await mkdir(other);
    await mkdir(join(other, "claude"));
    vi.stubEnv("PATH", `:relative:${other}:${root}`);
    const model = parseAgentManifest(JSON.stringify(claude), "bundled").model;
    const found = await hostDiscovery(
      { ...model, executables: ["missing", "claude"] },
      shell,
      root,
    );
    expect(found).toMatchObject({
      command: cli,
      version: "2.1.296 (Claude Code)",
      help: "--settings --mcp-config",
    });
    expect(found.env).not.toHaveProperty("NODE_OPTIONS");
    await chmod(cli, 0o600);
    await expect(hostDiscovery(model, shell, root)).rejects.toMatchObject({
      reason: "remote_agent_unavailable",
    });
    await chmod(cli, 0o700);
    const failed = await script("failed-shell", "process.exit(1)");
    expect((await hostDiscovery(model, failed, root)).command).toBe(cli);
    await writeFile(cli, `#!${process.execPath}\nprocess.exit(2)`, { mode: 0o700 });
    expect(await hostDiscovery(model, failed, root)).toMatchObject({ version: "", help: "" });
  },
);
test.skipIf(process.platform === "win32")(
  "remote probes bound stdout, stderr and deadline and never retain descendants holding pipes open",
  async () => {
    await expect(
      hostProbe(process.execPath, ["-e", "process.stdout.write('fixed')"], root),
    ).resolves.toBe("fixed");
    for (const stream of ["stdout", "stderr"])
      await expect(
        hostProbe(process.execPath, ["-e", `process.${stream}.write(Buffer.alloc(262145))`], root),
      ).rejects.toThrow("exceeded");
    await expect(hostProbe(process.execPath, ["-e", "process.exit(1)"], root)).rejects.toThrow(
      "failed",
    );
    await expect(hostProbe(join(root, "missing"), [], root)).rejects.toThrow();
    await expect(
      hostProbe(process.execPath, ["-e", "process.stdout.write(Buffer.from([255]))"], root),
    ).rejects.toThrow();
    const program =
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]});process.stdout.write('done');process.exit(0)";
    expect(await hostProbe(process.execPath, ["-e", program], root)).toBe("done");
    vi.useFakeTimers();
    const pending = hostProbe(process.execPath, ["-e", "setTimeout(()=>{},10000)"], root);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    vi.useRealTimers();
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw new Error("already exited");
    });
    expect(await hostProbe(process.execPath, ["-e", "console.log('gone')"], root)).toBe("gone\n");
  },
);
test.skipIf(process.platform === "win32")(
  "remote checkout validation requires canonical paths, live Git membership and the same common directory",
  async () => {
    const repo = join(root, "repo");
    const tree = join(root, "tree");
    await mkdir(repo);
    gitSync(["init", "-q", "-b", "main"], { cwd: repo });
    gitSync(
      [
        "-c",
        "user.name=Foom",
        "-c",
        "user.email=foom@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { cwd: repo },
    );
    gitSync(["worktree", "add", "-b", "child", tree], { cwd: repo });
    const env = { PATH: dirname("/usr/bin/git") };
    const identity = await remoteCheckout(repo, tree, env);
    expect(await remoteCheckout(repo, tree, env)).toBe(identity);
    const linked = join(root, "linked");
    await symlink(tree, linked);
    await expect(remoteCheckout(repo, linked, env)).rejects.toThrow("changed");
    await expect(remoteCheckout(repo, root, env)).rejects.toThrow("unavailable");
    gitSync(["worktree", "lock", tree], { cwd: repo });
    await expect(remoteCheckout(repo, tree, env)).rejects.toThrow("unavailable");
  },
);
