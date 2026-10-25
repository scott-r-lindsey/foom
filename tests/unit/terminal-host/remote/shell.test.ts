import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type * as OS from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../../../../src/terminal-host/terminal-manager", () => ({ TerminalManager: vi.fn() }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof OS>()),
  userInfo: () => ({ shell: process.execPath }),
}));
import { remoteShell } from "../../../../src/terminal-host/remote/daemon";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("prefers the daemon SHELL and consults the account only if it is invalid", () => {
  vi.stubEnv("SHELL", process.execPath);
  const account = vi.fn(() => process.execPath);
  expect(remoteShell(undefined, account)).toBe(process.execPath);
  expect(account).not.toHaveBeenCalled();
  for (const invalid of ["", "relative-shell", join(tmpdir(), "missing-remote-shell"), tmpdir()]) {
    expect(remoteShell(invalid, account)).toBe(process.execPath);
  }
  expect(account).toHaveBeenCalledTimes(4);
  expect(remoteShell("invalid")).toBe(process.execPath);
  vi.stubEnv("SHELL", undefined);
  expect(remoteShell(undefined, account)).toBe(process.execPath);
});
test("falls back to /bin/sh when neither remote shell is valid or account lookup fails", () => {
  for (const invalid of [
    null,
    "",
    "relative-shell",
    join(tmpdir(), "missing-account-shell"),
    tmpdir(),
  ]) {
    expect(remoteShell("invalid", () => invalid)).toBe("/bin/sh");
  }
  expect(
    remoteShell("invalid", () => {
      throw new Error("no account");
    }),
  ).toBe("/bin/sh");
});
test.skipIf(process.platform === "win32")(
  "rejects a regular file without execute permission in either source",
  () => {
    const root = mkdtempSync(join(tmpdir(), "remote-shell-"));
    roots.push(root);
    const shell = join(root, "shell");
    writeFileSync(shell, "#!/bin/sh\n", { mode: 0o600 });
    expect(remoteShell(shell, () => process.execPath)).toBe(process.execPath);
    expect(remoteShell("invalid", () => shell)).toBe("/bin/sh");
    chmodSync(shell, 0o700);
    expect(remoteShell(shell, () => null)).toBe(shell);
  },
);
