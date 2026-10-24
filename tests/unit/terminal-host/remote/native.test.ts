import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ asset: vi.fn(), load: vi.fn() }));
vi.mock("node:sea", () => ({ getAsset: mock.asset }));
vi.mock("node:module", () => ({ createRequire: () => mock.load }));
import { loadNativeModule } from "../../../../src/terminal-host/remote/native";
const executable = process.execPath;
const platform = process.platform;
let root: string | undefined;
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: executable });
  Object.defineProperty(process, "platform", { value: platform });
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.clearAllMocks();
});
test.skipIf(process.platform === "win32")(
  "extracts only embedded native assets, verifies cached bytes and refuses links/permissions",
  () => {
    root = mkdtempSync(join(tmpdir(), "host-native-"));
    Object.defineProperty(process, "execPath", { value: join(root, "foom-host") });
    mock.asset.mockReturnValue(new TextEncoder().encode("native").buffer);
    mock.load.mockReturnValue({ spawn: "fixture" });
    expect(loadNativeModule("pty")).toEqual({
      dir: join(root, "native"),
      module: { spawn: "fixture" },
    });
    expect(loadNativeModule("pty").dir).toBe(join(root, "native"));
    expect(readFileSync(join(root, "native/pty.node"), "utf8")).toBe("native");
    chmodSync(join(root, "native/pty.node"), 0o644);
    expect(() => loadNativeModule("pty")).toThrow("Unsafe");
    chmodSync(join(root, "native/pty.node"), 0o600);
    writeFileSync(join(root, "native/pty.node"), "tamper");
    expect(() => loadNativeModule("pty")).toThrow("Unsafe");
    rmSync(join(root, "native/pty.node"));
    symlinkSync(join(root, "outside"), join(root, "native/pty.node"));
    expect(() => loadNativeModule("pty")).toThrow();
    expect(() => loadNativeModule("unknown")).toThrow("Unsupported");
    rmSync(join(root, "native/pty.node"));
    Object.defineProperty(process, "platform", { value: "darwin" });
    loadNativeModule("pty");
    expect(readFileSync(join(root, "native/spawn-helper"), "utf8")).toBe("native");
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(() => loadNativeModule("pty")).toThrow("Unsupported");
  },
);
