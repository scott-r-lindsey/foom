import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { WakeGuards } from "../../../../src/main/terminals/wake-guards";
import { wakeLeaseValid } from "../../../../src/terminal-host/wake-lease";
import { privateDirectory } from "../../../../src/node-common/private-files";
vi.mock("../../../../src/node-common/private-files", () => ({
  privateDirectory: vi.fn(() => mkdtemp(join(tmpdir(), "foom-wake-unit-"))),
}));
const guards: WakeGuards[] = [];
afterEach(async () => {
  await Promise.all(guards.splice(0).map((guard) => guard.dispose()));
  vi.restoreAllMocks();
});
function create() {
  const guard = new WakeGuards();
  guards.push(guard);
  return guard;
}

test.each(["focus", "grant", "enablement"])(
  "%s withdrawal irrevocably invalidates a dispatched file token before its deferred host callback",
  async (cause) => {
    const guard = create();
    let eligible = true;
    const lease = await guard.create(() => eligible);
    if (!lease) throw new Error("Missing lease");
    try {
      expect(wakeLeaseValid(lease.token)).toBe(true);
      eligible = false;
      guard.recheck(cause === "focus");
      eligible = true;
      expect(wakeLeaseValid(lease.token)).toBe(false);
      guard.recheck();
      expect(wakeLeaseValid(lease.token)).toBe(false);
    } finally {
      lease.release();
    }
    expect(wakeLeaseValid(lease.token)).toBe(false);
  },
);
test("withdrawal during asynchronous root creation is latched, even if eligibility returns", async () => {
  const ready = Promise.withResolvers<string>();
  vi.mocked(privateDirectory).mockReturnValueOnce(ready.promise);
  const guard = create();
  let eligible = true;
  const pending = guard.create(() => eligible);
  eligible = false;
  guard.recheck();
  eligible = true;
  ready.resolve(await mkdtemp(join(tmpdir(), "foom-wake-unit-")));
  expect(await pending).toBeUndefined();
  await guard.dispose();
  expect(await guard.create(() => true)).toBeUndefined();
});
test("missing authority and closed guards never provide a token; shutdown revokes pending leases", async () => {
  const guard = create();
  expect(await guard.create(() => false)).toBeUndefined();
  expect(
    await guard.create(() => {
      throw new Error("revoked");
    }),
  ).toBeUndefined();
  const lease = await guard.create(() => true);
  if (!lease) throw new Error("Missing lease");
  await guard.dispose();
  expect(wakeLeaseValid(lease.token)).toBe(false);
  lease.release();
});
test("failed private-root setup refuses creation and remains safe to dispose", async () => {
  const guard = create();
  vi.mocked(privateDirectory).mockRejectedValueOnce(new Error("unavailable"));
  await expect(guard.create(() => true)).rejects.toThrow("unavailable");
  await guard.dispose();
});
test("bounded host token reads refuse unknown, altered, non-file and linked paths", async () => {
  const guard = create();
  const lease = await guard.create(() => true);
  if (!lease) throw new Error("Missing lease");
  try {
    expect(wakeLeaseValid({ ...lease.token, nonce: "f".repeat(32) })).toBe(false);
    truncateSync(lease.token.path, 0);
    expect(wakeLeaseValid(lease.token)).toBe(false);
    await writeFile(lease.token.path, "x".repeat(33));
    expect(wakeLeaseValid(lease.token)).toBe(false);
    const directory = `${lease.token.path}-directory`;
    await mkdir(directory);
    expect(wakeLeaseValid({ ...lease.token, path: directory })).toBe(false);
    await rm(directory, { recursive: true });
    if (process.platform !== "win32") {
      const link = `${lease.token.path}-link`;
      await symlink(lease.token.path, link);
      expect(wakeLeaseValid({ ...lease.token, path: link })).toBe(false);
      await rm(link);
    }
  } finally {
    lease.release();
  }
});
