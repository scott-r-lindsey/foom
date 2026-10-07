import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  privateDirectory,
  createPrivateFile,
  atomicPrivate,
  readDiscovery,
} from "../../../../src/main/control/private-files";

const run = vi.hoisted(() => vi.fn(() => Promise.resolve({ stdout: "", stderr: "" })));
vi.mock("node:child_process", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: run });
  return { ...actual, execFile };
});
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  run.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  if (root) await rm(root, { recursive: true, force: true });
});
it("uses a fixed DACL program with data-only paths and refuses ACL verification failures", async () => {
  root = await mkdtemp(join(tmpdir(), "foom-windows-acl-"));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const directory = await privateDirectory(root);
  expect(run).toHaveBeenCalledTimes(2);
  const args: unknown[] = run.mock.calls[0] ?? [];
  expect(args[0]).toBe("powershell.exe");
  expect(args[1]).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    expect.stringContaining("ReparsePoint"),
  ]);
  expect(args[2]).toHaveProperty("env.FOOM_PRIVATE_PATH", directory);
  expect(args[2]).toHaveProperty("env.FOOM_PRIVATE_CREATE", "1");
  const metadata = {
    version: 1,
    endpoint: "http://127.0.0.1:54321/control/v1",
    instanceId: "instance",
  };
  await atomicPrivate(directory, "discovery.json", metadata);
  expect(await readDiscovery(directory)).toEqual(metadata);
  const refused = join(directory, "refused.json");
  run.mockRejectedValueOnce(new Error("owner refused"));
  await expect(createPrivateFile(refused)).rejects.toThrow("owner refused");
  await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
  run.mockRejectedValueOnce(new Error("DACL refused"));
  await expect(privateDirectory(root)).rejects.toThrow("DACL refused");
});
