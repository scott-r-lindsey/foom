import * as fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteImages } from "../../../../src/terminal-host/remote/image-files";
import { IMAGE_BYTES } from "../../../../src/shared/image-paste";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
  "base64",
);
test.skipIf(process.platform === "win32")(
  "remote private image storage quotas, cancellation, startup purge and unsafe-entry refusal",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "image-host-"));
    const outside = await mkdtemp(join(tmpdir(), "image-outside-"));
    try {
      await mkdir(join(home, ".foom-host"), { mode: 0o700 });
      const images = new RemoteImages(home);
      await images.ready;
      await expect(images.put("bad", Buffer.alloc(0), () => true)).rejects.toThrow();
      await expect(images.put("cancel", png, () => false)).rejects.toThrow();
      const path = await images.put("one", png, () => true);
      expect(await readFile(path)).toEqual(png);
      for (let n = 1; n < 16; n++) await images.put("one", png, () => true);
      await expect(images.put("one", png, () => true)).rejects.toThrow("quota");
      await images.close("one");
      await images.close("none");
      const large = Buffer.alloc(IMAGE_BYTES);
      png.copy(large);
      for (let n = 0; n < 8; n++) await images.put("large", large, () => true);
      await expect(images.put("large", png, () => true)).rejects.toThrow("quota");
      await images.close("large");
      let checks = 0;
      await expect(images.put("cancelled", png, () => ++checks === 1)).rejects.toThrow("cancelled");
      await images.close("cancelled");
      await images.put("crashed", png, () => true);
      await new RemoteImages(home).ready;
      expect(await readdir(join(home, ".foom-host/images"))).toEqual([]);
      await writeFile(join(outside, "keep"), "safe");
      const link = join(home, ".foom-host/images", "a".repeat(32));
      await symlink(outside, link);
      await expect(new RemoteImages(home).ready).rejects.toThrow();
      expect(await readFile(join(outside, "keep"), "utf8")).toBe("safe");
      await rm(link);
      const dir = join(home, ".foom-host/images", "b".repeat(32));
      await mkdir(dir, { mode: 0o700 });
      const file = join(dir, `image-${"c".repeat(32)}.png`);
      await writeFile(file, png, { mode: 0o644 });
      await expect(new RemoteImages(home).ready).rejects.toThrow();
      await chmod(file, 0o600);
      await new RemoteImages(home).ready;
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, "unexpected"), "safe");
      await expect(new RemoteImages(home).ready).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "remote startup sweeps in batches and failed close can be retried",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "image-host-batch-"));
    try {
      await mkdir(join(home, ".foom-host"), { mode: 0o700 });
      const initial = new RemoteImages(home);
      await initial.ready;
      const root = join(home, ".foom-host/images");
      await writeFile(join(root, "unrelated"), "keep");
      for (let n = 0; n < 32; n++)
        await mkdir(join(root, n.toString(16).padStart(32, "0")), { mode: 0o700 });
      const restarted = new RemoteImages(home);
      await restarted.ready;
      expect(await readdir(root)).toEqual(["unrelated"]);
      const path = await restarted.put("one", png, () => true);
      const fail = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("disk failure"));
      try {
        await expect(restarted.close("one")).rejects.toThrow("disk failure");
      } finally {
        fail.mockRestore();
      }
      expect(await readFile(path)).toEqual(png);
      await Promise.all([restarted.close("one"), restarted.close("one")]);
      expect(await readdir(root)).toEqual(["unrelated"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "closing a session with no image files does not wait for the startup sweep",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "image-startup-"));
    const initialize = Promise.withResolvers<undefined>();
    try {
      await mkdir(join(home, ".foom-host"), { mode: 0o700 });
      const images = new RemoteImages(home, initialize.promise);
      let closed = false;
      const closing = images.close("shell").then(() => {
        closed = true;
      });
      try {
        await vi.waitFor(() => {
          expect(closed).toBe(true);
        });
      } finally {
        initialize.resolve(undefined);
        await images.ready;
        await closing;
      }
    } finally {
      initialize.resolve(undefined);
      await rm(home, { recursive: true, force: true });
    }
  },
);
