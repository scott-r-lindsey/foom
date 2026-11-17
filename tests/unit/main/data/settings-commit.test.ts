import type * as Fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
const gate = vi.hoisted(() => ({
  beforeRename: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await gate.beforeRename();
      return fs.rename(...args);
    },
  };
});
import { SettingsStore } from "../../../../src/main/setup/settings";
const roots: string[] = [];
afterEach(async () => {
  gate.beforeRename.mockReset();
  gate.beforeRename.mockResolvedValue();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function store() {
  const root = await mkdtemp(join(tmpdir(), "foom-view-commit-"));
  roots.push(root);
  return SettingsStore.open(root);
}
test.each([false, true])(
  "views never expose a staged profile write and concurrent accepted config survives (rollback %s)",
  async (fail) => {
    const settings = await store();
    let release = () => {};
    let reject: (error: Error) => void = () => {};
    const held = new Promise<void>((resolve, decline) => {
      release = resolve;
      reject = decline;
    });
    gate.beforeRename.mockClear();
    gate.beforeRename.mockReturnValueOnce(held);
    const updating = settings.update({ setupComplete: true });
    const settled = updating.then(
      () => "committed",
      () => "failed",
    );
    await vi.waitFor(() => {
      expect(gate.beforeRename).toHaveBeenCalledOnce();
    });
    expect(settings.get().setupComplete).toBe(false);
    settings.setConfig({ hooks: false });
    expect(settings.get().hooks).toBe(false);
    expect(settings.get().setupComplete).toBe(false);
    if (fail) reject(new Error("fixture disk failure"));
    else release();
    expect(await settled).toBe(fail ? "failed" : "committed");
    expect(settings.get().setupComplete).toBe(!fail);
    expect(settings.get().hooks).toBe(false);
    await settings.update({ showNestedRepositoryNames: true });
    expect(settings.get().hooks).toBe(false);
  },
);
