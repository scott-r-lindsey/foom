import {
  mkdtemp,
  mkdir,
  writeFile,
  readlink,
  readFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  execute: vi.fn<(file: string, args: string[], options: unknown) => void>(),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    calls.execute(file, args, options);
    callback(null);
  },
}));
import { installCli } from "../../../src/cli/install";
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-install-"));
  paths.push(root);
  const bin = join(root, "bin 日本語");
  await mkdir(bin);
  const executable = join(root, "foom");
  await writeFile(executable, "binary");
  return { root, bin, executable };
}
it("installs exclusively, detects relocation, and removes only its own stale link", async () => {
  const { bin, executable } = await fixture();
  expect(await installCli(executable, bin, false, {}, "linux")).toContain("CLI link installed");
  expect(await readlink(join(bin, "foom"))).toBe(executable);
  await expect(installCli(executable, bin, false, {}, "linux")).rejects.toThrow();
  await rm(executable);
  expect(await installCli(executable, bin, true, {}, "linux")).toContain("removed");
  await expect(readFile(join(bin, ".foom-cli-install.json"))).rejects.toThrow();
});
it("never clobbers another command, changed links, or shell configuration", async () => {
  const { root, bin, executable } = await fixture();
  await expect(installCli(executable, "relative", false, {}, "linux")).rejects.toThrow(
    "invalid_request",
  );
  await expect(installCli(executable, `${bin};extra`, false, {}, "linux")).rejects.toThrow(
    "invalid_request",
  );
  await expect(installCli(executable, bin, false, { PATH: root }, "linux")).rejects.toThrow(
    "conflict",
  );
  await writeFile(join(bin, "foom"), "unrelated");
  await expect(installCli(executable, bin, false, {}, "linux")).rejects.toThrow();
  expect(await readFile(join(bin, "foom"), "utf8")).toBe("unrelated");
  await expect(readFile(join(bin, ".foom-cli-install.json"))).rejects.toThrow();
  await rm(join(bin, "foom"));
  await installCli(executable, bin, false, { PATH: join(root, "missing") }, "linux");
  await rm(join(bin, "foom"));
  await symlink(join(root, "other"), join(bin, "foom"));
  await expect(installCli(executable, bin, true, {}, "linux")).rejects.toThrow("conflict");
  await rm(join(bin, ".foom-cli-install.json"));
  await symlink(executable, join(bin, ".foom-cli-install.json"));
  await expect(installCli(executable, bin, true, {}, "linux")).rejects.toThrow("conflict");
});
it("refuses invalid ownership records and non-file executables", async () => {
  const { root, bin, executable } = await fixture();
  await expect(installCli(root, bin, false, {}, "linux")).rejects.toThrow("unavailable");
  for (const record of [
    {},
    { version: 1, target: "relative" },
    { version: 2, target: executable },
  ]) {
    await writeFile(join(bin, ".foom-cli-install.json"), JSON.stringify(record));
    await expect(installCli(executable, bin, true, {}, "linux")).rejects.toThrow("conflict");
  }
});
it("uses a fixed Windows registry program with path data in the environment", async () => {
  const { root, bin, executable } = await fixture();
  await expect(installCli(executable, bin, false, {}, "win32")).rejects.toThrow("invalid_request");
  const helper = join(bin, "foom.exe");
  await writeFile(helper, "binary");
  expect(await installCli(helper, bin, false, { PATH: `${root};` }, "win32")).toContain(
    "user PATH",
  );
  expect(calls.execute).toHaveBeenLastCalledWith(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("CurrentUser")],
    expect.objectContaining({
      env: { PATH: `${root};`, FOOM_CLI_DIRECTORY: bin, FOOM_CLI_REMOVE: "0" },
    }),
  );
  const script: unknown = calls.execute.mock.calls.at(-1)?.[1]?.[3];
  expect(script).toEqual(expect.stringContaining("SendMessageTimeout"));
  expect(script).toEqual(expect.stringContaining("'Environment',2,2000"));
  const moved = join(root, "moved 日本語");
  await rename(bin, moved);
  await installCli(join(moved, "foom.exe"), moved, true, {}, "win32");
  await rename(moved, bin);
  expect(calls.execute).toHaveBeenLastCalledWith(
    "powershell.exe",
    expect.any(Array),
    expect.objectContaining({ env: { FOOM_CLI_DIRECTORY: bin, FOOM_CLI_REMOVE: "1" } }),
  );
  await writeFile(
    join(bin, ".foom-cli-install.json"),
    JSON.stringify({ version: 1, target: executable }),
  );
  await expect(installCli(helper, bin, true, {}, "win32")).rejects.toThrow("conflict");
  await rm(join(bin, ".foom-cli-install.json"));
  await writeFile(join(root, "foom.cmd"), "other");
  await expect(installCli(helper, bin, false, { PATH: root }, "win32")).rejects.toThrow("conflict");
});
