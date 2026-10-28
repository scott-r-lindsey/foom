import { afterEach, expect, test, vi } from "vitest";
import { localResources } from "../../../../src/main/setup/local-host";
import { readFile } from "node:fs/promises";
import { readLoginShell } from "../../../../src/main/login-shell";
vi.mock("node:os", () => ({
  cpus: () => [0, 1],
  freemem: () => 500,
  totalmem: () => 10000,
  loadavg: () => [1, 2, 3],
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../../../../src/main/login-shell", () => ({ readLoginShell: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function platform(name: string) {
  vi.stubGlobal("process", { ...process, platform: name });
}
test("local Linux placement signals use MemAvailable rather than free memory", async () => {
  platform("linux");
  vi.mocked(readFile).mockResolvedValue("MemFree: 1 kB\nMemAvailable: 4 kB\n");
  expect(await localResources()).toEqual({
    cores: 2,
    load: [1, 2, 3],
    memoryTotal: 10000,
    memoryAvailable: 4096,
  });
  vi.mocked(readFile).mockResolvedValue("MemFree: 1 kB\n");
  await expect(localResources()).rejects.toThrow("Memory unavailable");
  vi.mocked(readFile).mockRejectedValue(new Error("Unavailable"));
  await expect(localResources()).rejects.toThrow();
});
test("local macOS uses the bounded fixed vm_stat reader and rejects incomplete observations", async () => {
  platform("darwin");
  vi.mocked(readLoginShell).mockResolvedValue({
    stdout: "page size of 4096 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n",
    stderr: "",
  });
  expect((await localResources()).memoryAvailable).toBe(10000);
  expect(readLoginShell).toHaveBeenCalledWith(
    "/usr/bin/vm_stat",
    [],
    expect.objectContaining({ cwd: "/", timeout: 5000, maxBuffer: 65536 }),
  );
  for (const stdout of ["bad", "page size of 4096 bytes\nPages free: 1.\n"]) {
    vi.mocked(readLoginShell).mockResolvedValue({ stdout, stderr: "" });
    await expect(localResources()).rejects.toThrow("Memory unavailable");
  }
});
test("other local platforms use available physical memory", async () => {
  platform("win32");
  expect((await localResources()).memoryAvailable).toBe(500);
  expect(readLoginShell).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});
