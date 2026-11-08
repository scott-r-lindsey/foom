import type { VendorScript } from "../../../src/node-common/vendor-install";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn<(script: VendorScript, home: string, env: NodeJS.ProcessEnv) => Promise<number>>(),
  access: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../../../src/node-common/vendor-install", () => ({ runVendorScript: mocks.run }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { installLocalAgent } from "../../../src/node-common/local-agent-install";
const platform = process.platform;
function machine(value: string) {
  Object.defineProperty(process, "platform", { value });
}
afterEach(() => {
  machine(platform);
  vi.unstubAllEnvs();
});
beforeEach(() => {
  machine("linux");
  vi.stubEnv("FOOM_SETTINGS_INSTALL", "1");
  mocks.run.mockReset().mockResolvedValue(0);
  mocks.access.mockReset().mockResolvedValue(undefined);
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
});
test("all six bundled agents select vendor scripts with no inherited Foom credentials", async () => {
  vi.stubEnv("FOOM_TOKEN", "fixture-secret");
  vi.stubEnv("FOOM_CONTROL_URL", "fixture-url");
  for (const id of ["claude", "codex", "agy", "copilot", "opencode", "pi"]) {
    expect(await installLocalAgent(id)).toBe(0);
    const call = mocks.run.mock.lastCall;
    expect(call?.[0].url).toMatch(/^https:/u);
    expect(call?.[0].arguments).toEqual([]);
    expect(call?.[2]).not.toHaveProperty("FOOM_SETTINGS_INSTALL");
    expect(call?.[2]).not.toHaveProperty("FOOM_TOKEN");
    expect(call?.[2]).not.toHaveProperty("FOOM_CONTROL_URL");
  }
  expect(mocks.spawn).not.toHaveBeenCalled();
});
test("unknown IDs and unsupported platforms cannot install", async () => {
  for (const id of [undefined, "custom", "claude;id"]) expect(await installLocalAgent(id)).toBe(2);
  machine("win32");
  expect(await installLocalAgent("claude")).toBe(2);
  expect(mocks.run).not.toHaveBeenCalled();
});
test("macOS prefers an existing Homebrew recipe only on the login PATH", async () => {
  machine("darwin");
  vi.stubEnv("PATH", "/fixture:/usr/local/bin");
  expect(await installLocalAgent("codex")).toBe(0);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "/usr/local/bin/brew",
    ["install", "--cask", "codex"],
    expect.objectContaining({ shell: false, stdio: "inherit" }),
  );
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.access.mockRejectedValue(new Error("missing"));
  expect(await installLocalAgent("codex")).toBe(0);
  expect(mocks.run).toHaveBeenCalledOnce();
  mocks.access.mockClear();
  vi.stubEnv("PATH", "/fixture");
  expect(await installLocalAgent("codex")).toBe(0);
  expect(mocks.access).not.toHaveBeenCalled();
  vi.stubEnv("PATH", undefined);
  expect(await installLocalAgent("codex")).toBe(0);
});
test.each([9, null, "error"])(
  "package manager failure %s never silently tries a script",
  async (code) => {
    machine("darwin");
    vi.stubEnv("PATH", "/opt/homebrew/bin");
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          code === "error" ? "error" : "exit",
          code === "error" ? new Error("fixture") : code,
        ),
      );
      return child;
    });
    expect(await installLocalAgent("codex")).toBe(code === 9 ? 9 : 1);
    expect(mocks.run).not.toHaveBeenCalled();
  },
);

test("missing accidental-use marker refuses even a valid bundled selector", async () => {
  vi.stubEnv("FOOM_SETTINGS_INSTALL", undefined);
  expect(await installLocalAgent("claude")).toBe(2);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
