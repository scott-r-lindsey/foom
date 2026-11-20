import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const hooks = vi.hoisted(() => ({
  beforeLstat: undefined as undefined | ((path: string) => Promise<void>),
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
  afterOpen: undefined as
    | undefined
    | ((file: FsPromises.FileHandle, path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      await hooks.beforeLstat?.(String(args[0]));
      return fs.lstat(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const file = await fs.open(...args);
      await hooks.afterOpen?.(file, String(args[0]));
      return file;
    },
  };
});
import { validateConfig } from "../../../src/cli/config";
const roots: string[] = [];
afterEach(async () => {
  hooks.beforeLstat = undefined;
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-config-race-"));
  roots.push(root);
  const inside = join(root, "config");
  const outside = join(root, "outside");
  await mkdir(inside);
  await mkdir(outside);
  for (const dir of [inside, outside])
    await writeFile(join(dir, "settings.json"), '{"kind":"settings"}');
  return { root, inside, outside };
}
test("a parent replaced between validation and open cannot supply an outside file", async () => {
  const { inside, outside } = await fixture();
  const read = vi.fn();
  const close = vi.fn();
  hooks.beforeOpen = async () => {
    hooks.beforeOpen = undefined;
    await rename(inside, `${inside}-old`);
    await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir");
  };
  hooks.afterOpen = async (file) => {
    vi.spyOn(file, "read").mockImplementation(read);
    const original = file.close.bind(file);
    vi.spyOn(file, "close").mockImplementation(async () => {
      close();
      await original();
    });
    await Promise.resolve();
  };
  const result = await validateConfig(inside);
  expect(result.code).toBe(1);
  expect(result.problems.every((p) => p.reason === "unsafe-file")).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
test("file replacement before open and growth after stat fail closed", async () => {
  const { inside } = await fixture();
  const path = join(inside, "settings.json");
  hooks.beforeOpen = async () => {
    hooks.beforeOpen = undefined;
    await rename(path, `${path}-old`);
    await writeFile(path, '{"kind":"settings"}');
  };
  expect(await validateConfig(path)).toMatchObject({
    code: 1,
    problems: [{ reason: "unsafe-file" }],
  });
  hooks.afterOpen = async (file) => {
    const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => {
      const info = await stat();
      await appendFile(path, " ");
      return info;
    });
    await Promise.resolve();
  };
  expect(await validateConfig(path)).toMatchObject({
    code: 1,
    problems: [{ reason: "unsafe-file" }],
  });
});

test("a regular Settings lock may disappear between the directory walk and lstat", async () => {
  const { inside } = await fixture();
  const lock = join(inside, ".foom-settings.lock");
  await writeFile(lock, "{}");
  const removed = vi.fn();
  hooks.beforeLstat = async (path) => {
    if (path !== lock) return;
    await rm(lock);
    removed();
  };
  expect(await validateConfig(inside)).toEqual({ problems: [], code: 0 });
  expect(removed).toHaveBeenCalledOnce();
});
