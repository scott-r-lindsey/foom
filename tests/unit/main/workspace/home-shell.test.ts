import { afterEach, expect, test, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ stdout: string }>>());
vi.mock("node:child_process", () => {
  const execFile = () => {};
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: execute });
  return { execFile };
});
import { homeShellFacts, shellPath } from "../../../../src/main/workspace/home-shell";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  execute.mockReset();
});
test("probes the fixed shell with bounded argument arrays on Unix and Windows", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.stubEnv("SHELL", "/bin/zsh");
  execute.mockResolvedValue({ stdout: "zsh 5.9\nother text" });
  expect(await homeShellFacts()).toMatchObject({ path: "/bin/zsh", version: "zsh 5.9" });
  expect(execute).toHaveBeenLastCalledWith(
    "/bin/zsh",
    ["--version"],
    expect.objectContaining({ timeout: 3000, maxBuffer: 16384 }),
  );
  vi.stubEnv("SHELL", "");
  expect(shellPath()).toBe("/bin/bash");
  execute.mockResolvedValue({ stdout: "" });
  expect((await homeShellFacts()).version).toBeNull();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  execute.mockResolvedValue({ stdout: "7.5.1" });
  expect(await homeShellFacts()).toMatchObject({ path: "powershell.exe", version: "7.5.1" });
  expect(execute).toHaveBeenLastCalledWith(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    expect.any(Object),
  );
  execute.mockRejectedValue(Error("timed out"));
  expect((await homeShellFacts()).version).toBeNull();
});
