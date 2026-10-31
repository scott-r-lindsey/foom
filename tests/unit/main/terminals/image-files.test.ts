import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  readdir,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ImageFiles } from "../../../../src/main/terminals/image-files";
import { IMAGE_BYTES } from "../../../../src/shared/image-paste";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
function files() {
  const value = new ImageFiles(() => randomUUID());
  return value;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function ready() {
  const store = files();
  const root = await store.start();
  roots.push(root);
  return { store, root };
}
test("private publication outside checkouts, per-session count quota, explicit discard and close", async () => {
  const { store, root } = await ready();
  const signal = new AbortController().signal;
  await expect(store.put("bad", Buffer.alloc(1), signal)).rejects.toThrow();
  const path = await store.put("one", png, signal);
  expect(path.startsWith(root)).toBe(true);
  expect(await readFile(path)).toEqual(png);
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
  for (let n = 1; n < 16; n++) await store.put("one", png, signal);
  await expect(store.put("one", png, signal)).rejects.toThrow("quota");
  await store.discard("none", path, png.length);
  await store.discard("one", "/outside", png.length);
  await store.discard("one", path, png.length);
  await store.put("one", png, signal);
  await store.close("one");
  expect(await readdir(root)).toEqual([]);
  await store.close("one");
  await store.dispose();
}, 60000);
test("32 MiB quota is independent of count; aborts do not publish", async () => {
  const { store, root } = await ready();
  const signal = new AbortController().signal;
  const large = Buffer.alloc(IMAGE_BYTES);
  png.copy(large);
  for (let n = 0; n < 8; n++) await store.put("one", large, signal);
  await expect(store.put("one", png, signal)).rejects.toThrow("quota");
  const cancel = new AbortController();
  cancel.abort();
  await expect(store.put("two", png, cancel.signal)).rejects.toThrow();
  await store.dispose();
  expect(await readdir(root)).toEqual([]);
}, 60000);
test.skipIf(process.platform === "win32")(
  "startup purges owned leftovers and refuses links/unsafe directories",
  async () => {
    const { store } = await ready();
    await store.put("one", png, new AbortController().signal);
    const profile = randomUUID();
    const first = new ImageFiles(() => profile);
    const owned = await first.start();
    roots.push(owned);
    await first.put("old", png, new AbortController().signal);
    const second = new ImageFiles(() => profile);
    await second.start();
    expect(await readdir(owned)).toEqual([]);
    const foreign = await mkdtemp(join(tmpdir(), "image-paste-outside-"));
    roots.push(foreign);
    await writeFile(join(foreign, "keep"), "keep");
    const link = join(owned, "a".repeat(32));
    await symlink(foreign, link);
    await expect(new ImageFiles(() => profile).start()).rejects.toThrow();
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("keep");
    await rm(link);
    const unsafe = join(owned, "b".repeat(32));
    await mkdir(unsafe, { mode: 0o755 });
    await expect(new ImageFiles(() => profile).start()).rejects.toThrow();
    await chmod(unsafe, 0o700);
    await writeFile(join(unsafe, "unexpected"), "keep", { mode: 0o600 });
    await expect(new ImageFiles(() => profile).start()).rejects.toThrow();
  },
);

test("cancellation after a write or publication deletes the unused file and releases quota", async () => {
  const { vi } = await import("vitest");
  const { store, root } = await ready();
  for (const checkpoint of [2, 3]) {
    const signal = new AbortController().signal;
    let checks = 0;
    const guard = vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
      if (++checks === checkpoint) throw new Error("cancelled");
    });
    await expect(store.put("cancelled", png, signal)).rejects.toThrow("cancelled");
    guard.mockRestore();
    const directories = await readdir(root);
    for (const name of directories) expect(await readdir(join(root, name))).toEqual([]);
  }
  const path = await store.put("cancelled", png, new AbortController().signal);
  expect(await readFile(path)).toEqual(png);
  await Promise.all([store.close("cancelled"), store.close("cancelled")]);
  expect(await readdir(root)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "startup sweep yields bounded batches and failed deletion remains retryable",
  async () => {
    const profile = randomUUID();
    const first = new ImageFiles(() => profile);
    const root = await first.start();
    roots.push(root);
    await writeFile(join(root, "unrelated"), "keep");
    for (let n = 0; n < 32; n++)
      await mkdir(join(root, n.toString(16).padStart(32, "0")), { mode: 0o700 });
    const restarted = new ImageFiles(() => profile);
    await restarted.start();
    expect(await readdir(root)).toEqual(["unrelated"]);
    const path = await restarted.put("session", png, new AbortController().signal);
    const fail = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("disk failure"));
    try {
      await expect(restarted.close("session")).rejects.toThrow("disk failure");
    } finally {
      fail.mockRestore();
    }
    expect(await readFile(path)).toEqual(png);
    await restarted.close("session");
    expect(await readdir(root)).toEqual(["unrelated"]);
  },
);
