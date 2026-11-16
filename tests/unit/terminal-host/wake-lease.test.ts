import type * as Fs from "node:fs";
import { openSync, readSync, fstatSync } from "node:fs";
import { mkdtemp, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { wakeLeaseValid } from "../../../src/terminal-host/wake-lease";
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    fstatSync: vi.fn(actual.fstatSync),
  };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});
async function fixture() {
  const actual = await vi.importActual<typeof Fs>("node:fs");
  const root = await mkdtemp(join(tmpdir(), "foom-wake-read-"));
  roots.push(root);
  const token = { path: join(root, "guard"), nonce: "a".repeat(32) };
  await writeFile(token.path, token.nonce);
  return { token, root, actual };
}
test("refuses a file replaced between identity observation and open", async () => {
  const { token, root, actual } = await fixture();
  const replacement = join(root, "replacement");
  await writeFile(replacement, token.nonce);
  vi.mocked(openSync).mockImplementationOnce(() => {
    actual.renameSync(replacement, token.path);
    return actual.openSync(token.path, "r");
  });
  expect(wakeLeaseValid(token)).toBe(false);
});
test.each(["directory", "device", "size"])("refuses changed opened %s metadata", async (kind) => {
  const { token, root, actual } = await fixture();
  vi.mocked(fstatSync).mockImplementationOnce(() => {
    const stat = actual.statSync(kind === "directory" ? root : token.path);
    if (kind === "device") Reflect.set(stat, "dev", stat.dev + 1);
    if (kind === "size") Reflect.set(stat, "size", 0);
    return stat;
  });
  expect(wakeLeaseValid(token)).toBe(false);
});
test.each(["before-read", "after-read", "replace"])(
  "refuses revocation %s at the write point",
  async (kind) => {
    const { token, root, actual } = await fixture();
    const replacement = join(root, "replacement");
    await writeFile(replacement, token.nonce);
    vi.mocked(readSync).mockImplementationOnce((fd, buffer) => {
      if (kind === "before-read") actual.truncateSync(token.path, 0);
      const count = actual.readSync(fd, buffer, 0, buffer.byteLength, 0);
      if (kind === "after-read") actual.truncateSync(token.path, 0);
      if (kind === "replace") actual.renameSync(replacement, token.path);
      return count;
    });
    expect(wakeLeaseValid(token)).toBe(false);
  },
);
test("refuses hard-linked token files", async () => {
  const { token, root } = await fixture();
  await link(token.path, join(root, "alias"));
  expect(wakeLeaseValid(token)).toBe(false);
});
