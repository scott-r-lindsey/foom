import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  canonicalRoot,
  type CanonicalRoot,
  openFlags,
  openInside,
  readInside,
  readPreview,
} from "../../../../src/main/previews/contained-files";
import { MAX_FILE_BYTES, MAX_MARKDOWN_BYTES } from "../../../../src/main/previews/policy";

const handles = new Map<
  number,
  {
    stat: () => Promise<fs.BigIntStats>;
    read: (body: Buffer, offset: number, length: number, position: number) => Promise<number>;
    close: () => Promise<void>;
  }
>();
const io = {
  fstat: (fd: number) => {
    const handle = handles.get(fd);
    if (!handle) throw new Error("Unknown descriptor");
    return handle.stat();
  },
  read: (fd: number, body: Buffer, offset: number, length: number, position: number) => {
    const handle = handles.get(fd);
    if (!handle) throw new Error("Unknown descriptor");
    return handle.read(body, offset, length, position);
  },
  close: (fd: number) => {
    const handle = handles.get(fd);
    if (!handle) throw new Error("Unknown descriptor");
    return handle.close();
  },
};

let base: string;
let root: string;
let captured: CanonicalRoot;
let outside: string;
beforeEach(() => {
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const fd = handle.fd;
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handles.set(fd, {
      stat: () => stat({ bigint: true }),
      read: async (...args) => (await read(...args)).bytesRead,
      close,
    });
    vi.spyOn(handle, "stat").mockImplementation(() => io.fstat(fd));
    vi.spyOn(handle, "read").mockImplementation(async (options) => {
      if (!options || !Buffer.isBuffer(options.buffer))
        throw new Error("Expected bounded buffer read");
      const buffer = options.buffer;
      const position = options.position ?? 0;
      if (typeof position !== "number") throw new Error("Expected numeric position");
      return {
        bytesRead: await io.read(
          fd,
          buffer,
          options.offset ?? 0,
          options.length ?? buffer.length,
          position,
        ),
        buffer,
      };
    });
    handle.close = () => io.close(fd);
    return handle;
  });
  base = fs.mkdtempSync(path.join(os.tmpdir(), "foom-preview-"));
  root = path.join(base, "tree");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "docs", "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(outside);
  fs.mkdirSync(`${root}-evil`);
  fs.writeFileSync(path.join(root, "docs", "page.html"), "<p>page</p>");
  fs.writeFileSync(path.join(root, "docs", "index.html"), "index");
  fs.writeFileSync(path.join(root, "docs", "assets", "a.css"), "p{}");
  fs.writeFileSync(path.join(root, "README.md"), "# readme");
  fs.writeFileSync(path.join(root, ".env"), "secret");
  fs.writeFileSync(path.join(root, ".git", "config"), "secret");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.writeFileSync(path.join(`${root}-evil`, "x.txt"), "sibling");
  captured = canonicalRoot(root);
  root = captured.path;
});
afterEach(() => {
  handles.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

async function body(pathname: string): Promise<string> {
  const result = await readInside(captured, pathname);
  if (result.status !== 200) throw new Error(result.reason);
  return result.body.toString();
}

test("serves pages, relative assets and directory indexes from owned handles", async () => {
  expect(await body("/docs/page.html")).toBe("<p>page</p>");
  expect(await body(new URL("assets/a.css", "foom-preview://id/docs/page.html").pathname)).toBe(
    "p{}",
  );
  expect(await body("/docs/")).toBe("index");
  expect(await body("/docs")).toBe("index");
  fs.writeFileSync(path.join(root, "index.html"), "root index");
  expect(await body("/")).toBe("root index");
  const opened = await openInside(captured, "/README.md");
  if (opened.status !== 200) throw new Error(opened.reason);
  try {
    expect(await opened.handle.readFile("utf8")).toBe("# readme");
    expect(opened.relative).toBe("README.md");
  } finally {
    await opened.handle.close();
  }
  expect(await readInside(captured, "/missing")).toEqual({ status: 404, reason: "missing" });
  expect((await readInside(captured, "/docs/assets/")).status).toBe(404);
  expect(await readInside(captured, "/.env")).toEqual({ status: 400, reason: "hidden" });
  expect(() => canonicalRoot(path.join(root, "README.md"))).toThrow("not a directory");
});

test("adapts hostile URLs and attaches headers to success and refusal", async () => {
  const good = await readPreview(captured, "foom-preview://id/docs/page.html", "foom-preview://id");
  expect(good.status).toBe(200);
  expect(good.headers["x-content-type-options"]).toBe("nosniff");
  for (const url of [
    "foom-preview://id/../../../../etc/hostname",
    "foom-preview://id/%2e%2e/etc/hostname",
  ])
    expect((await readPreview(captured, url, "foom-preview://id")).status).toBe(404);
  expect(
    (await readPreview(captured, "foom-preview://id/..%2f..%2fetc%2fhostname", "foom-preview://id"))
      .status,
  ).toBe(400);
  const bad = await readPreview(captured, {}, "foom-preview://id");
  expect(bad.status).toBe(400);
  expect(bad.headers["cache-control"]).toBe("no-store");
  expect((await readPreview(captured, "foom-preview://other/a", "foom-preview://id")).status).toBe(
    403,
  );
});

// File symlinks require Developer Mode or privileges on Windows. Junctions do not.
const links = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "foom-link-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();
test.skipIf(!links)(
  "refuses escaped, hidden and looping symlinks; allows contained targets",
  async () => {
    fs.symlinkSync(outside, path.join(root, "escape-dir"), "dir");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));
    fs.symlinkSync(`${root}-evil`, path.join(root, "prefix-sibling"), "dir");
    fs.symlinkSync(path.join(root, "README.md"), path.join(root, "inside-link.md"));
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "env-link.txt"));
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "git-link"), "dir");
    fs.symlinkSync(path.parse(root).root, path.join(root, "slash"), "dir");
    fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
    fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
    for (const pathname of [
      "/escape-dir/secret.txt",
      "/escape-file.txt",
      "/prefix-sibling/x.txt",
      "/slash",
    ])
      expect(await openInside(captured, pathname)).toEqual({ status: 403, reason: "escape" });
    for (const pathname of ["/env-link.txt", "/git-link/config"])
      expect(await openInside(captured, pathname)).toEqual({
        status: 403,
        reason: "target-hidden",
      });
    expect((await openInside(captured, "/loop-a")).status).toBe(404);
    expect(await body("/inside-link.md")).toBe("# readme");
    fs.rmSync(path.join(root, "docs"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "docs"), "dir");
    expect(await openInside(captured, "/docs/secret.txt")).toEqual({
      status: 403,
      reason: "escape",
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "refuses Windows junction escapes and hidden targets",
  async () => {
    fs.symlinkSync(outside, path.join(root, "junction"), "junction");
    expect(await openInside(captured, "/junction/secret.txt")).toEqual({
      status: 403,
      reason: "escape",
    });
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "hidden-junction"), "junction");
    expect(await openInside(captured, "/hidden-junction/config")).toEqual({
      status: 403,
      reason: "target-hidden",
    });
  },
);

test.skipIf(!links)("checks a directory's index realpath for escapes", async () => {
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "index.html"));
  expect(await openInside(captured, "/")).toEqual({ status: 403, reason: "escape" });
});

test("enforces limits at the descriptor and refuses non-files", async () => {
  for (const [name, size] of [
    ["big.bin", MAX_FILE_BYTES],
    ["big.md", MAX_MARKDOWN_BYTES],
  ] as const) {
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.alloc(size));
    expect((await readInside(captured, `/${name}`)).status).toBe(200);
    fs.appendFileSync(file, "x");
    expect(await openInside(captured, `/${name}`)).toEqual({ status: 413, reason: "too-large" });
  }
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(await openInside(captured, "/pipe")).toEqual({ status: 403, reason: "not-file" });
  }
  fs.writeFileSync(path.join(root, "data.xyz"), "x");
  const unknown = await readInside(captured, "/data.xyz");
  expect(unknown).toHaveProperty("type", "application/octet-stream");
});

test.each([1, 2 ** 60])(
  "closes handles on replacement, open/stat failures and bounded short reads (inode %s)",
  async (inode) => {
    const namedStat = fs.promises.stat;
    const fstat = io.fstat;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (name) => {
      const stat = await namedStat(name, { bigint: true });
      if (name !== root) stat.ino = BigInt(inode);
      return stat;
    });
    vi.spyOn(io, "fstat").mockImplementation(async (fd) => {
      const stat = await fstat(fd);
      stat.ino = BigInt(inode);
      return stat;
    });
    const close = vi.spyOn(io, "close");
    vi.spyOn(io, "fstat").mockImplementationOnce(async (fd) => {
      const stat = await fstat(fd);
      // A one-unit increment can round away for large Windows inode values.
      stat.ino = inode === 0 ? 1n : 0n;
      return stat;
    });
    expect(await openInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
    expect(close).toHaveBeenCalledTimes(1);
    vi.spyOn(io, "fstat").mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    expect(await openInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
    expect(close).toHaveBeenCalledTimes(2);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(() => {
      throw new Error("denied");
    });
    expect((await openInside(captured, "/README.md")).status).toBe(404);
    vi.spyOn(io, "read").mockResolvedValueOnce(0);
    expect(await body("/README.md")).toBe("");
    expect(close).toHaveBeenCalledTimes(3);
    vi.spyOn(io, "read").mockImplementationOnce(() => {
      throw new Error("read failure");
    });
    await expect(body("/README.md")).rejects.toThrow("read failure");
    expect(close).toHaveBeenCalledTimes(4);
  },
);

test("handles absent POSIX flags explicitly", () => {
  expect(openFlags({ O_RDONLY: 1 })).toBe(1);
  expect(openFlags({ O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 })).toBe(7);
});

test("refuses a final file replaced between stat and open", async () => {
  const originalOpen = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags, mode) => {
    fs.renameSync(path.join(root, "README.md"), path.join(root, "old.md"));
    fs.writeFileSync(path.join(root, "README.md"), "replacement");
    return originalOpen(file, flags, mode);
  });
  expect(await openInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
});

test.each(["ancestor", "root"] as const)(
  "refuses a %s replaced after resolution but before the later stat",
  async (replacement) => {
    fs.mkdirSync(path.join(outside, "docs"));
    fs.writeFileSync(path.join(outside, "page.html"), "outside secret");
    fs.writeFileSync(path.join(outside, "docs", "page.html"), "outside secret");
    const originalStat = fs.promises.stat;
    const file = path.join(root, "docs", "page.html");
    let stats = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (name) => {
      if (name === file && ++stats === 2) {
        // The first stat handles directory-index selection. At the later stat,
        // the earlier realpath and containment checks have already succeeded.
        const ancestor = replacement === "root" ? root : path.join(root, "docs");
        fs.renameSync(ancestor, `${ancestor}-old`);
        fs.symlinkSync(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
      }
      return originalStat(name, { bigint: true });
    });
    const read = vi.spyOn(io, "read");
    expect(await readInside(captured, "/docs/page.html")).toEqual({
      status: 403,
      reason: "escape",
    });
    expect(stats).toBeGreaterThanOrEqual(2);
    expect(read).not.toHaveBeenCalled();
  },
);

const platforms = ["linux", "darwin", "win32"] as const;

/** Exercise both OS strategies on every host; native suites also run on each OS. */
function verification(platform: NodeJS.Platform, resolve: () => string): void {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "linux") {
    vi.spyOn(fs.promises, "readlink").mockImplementation(() => Promise.resolve(resolve()));
  } else {
    const realpath = fs.promises.realpath;
    vi.spyOn(fs.promises, "realpath")
      .mockImplementationOnce((file) => realpath(file))
      .mockImplementation(() => Promise.resolve(resolve()));
  }
}

test.each(platforms)("%s serves a verified descriptor with the captured root", async (platform) => {
  verification(platform, () => path.join(root, "README.md"));
  expect(await body("/README.md")).toBe("# readme");
});

test("refuses an ordinary replacement directory at the captured root's spelling", async () => {
  fs.renameSync(root, `${root}-old`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "replacement secret");
  const read = vi.spyOn(io, "read");
  const close = vi.spyOn(io, "close");
  expect(await readInside(captured, "/README.md")).toEqual({ status: 403, reason: "escape" });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(["directory", "device"] as const)(
  "refuses descriptor %s mismatches before post-open verification",
  async (failure) => {
    const originalFstat = io.fstat;
    vi.spyOn(io, "fstat").mockImplementation(async (fd) => {
      const stat =
        failure === "directory" ? fs.statSync(root, { bigint: true }) : await originalFstat(fd);
      if (failure === "device") stat.dev += 1n;
      return stat;
    });
    const read = vi.spyOn(io, "read");
    const close = vi.spyOn(io, "close");
    expect(await readInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

test.each(platforms)(
  "%s closes without reading if post-open resolution fails",
  async (platform) => {
    verification(platform, () => {
      throw new Error("unavailable (including missing procfs)");
    });
    const read = vi.spyOn(io, "read");
    const close = vi.spyOn(io, "close");
    expect(await readInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

test.each(platforms)("%s rechecks post-open containment and forbidden names", async (platform) => {
  const read = vi.spyOn(io, "read");
  const close = vi.spyOn(io, "close");
  let target = path.join(outside, "secret.txt");
  verification(platform, () => target);
  // Reset the initial realpath response for each fallback request as well.
  for (const [resolved, reason] of [
    [path.join(outside, "secret.txt"), "escape"],
    [path.join(`${root}-evil`, "x.txt"), "escape"],
    [path.join(root, ".env"), "target-hidden"],
    [path.join(root, "__foom__", "markdown.js"), "target-reserved"],
    [path.join(root, "alias.txt."), "target-windows-trailing"],
  ] as const) {
    target = resolved;
    if (platform !== "linux")
      vi.mocked(fs.promises.realpath)
        .mockReset()
        .mockResolvedValueOnce(path.join(root, "README.md"))
        .mockImplementation(() => Promise.resolve(target));
    expect(await readInside(captured, "/README.md")).toEqual({ status: 403, reason });
  }
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(5);
});

test.each(platforms)("%s refuses a changed or unavailable captured root", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "linux")
    vi.spyOn(fs.promises, "readlink").mockResolvedValue(path.join(root, "README.md"));
  const originalStat = fs.promises.stat;
  const read = vi.spyOn(io, "read");
  const close = vi.spyOn(io, "close");
  for (const failure of ["missing", "file", "device", "inode"] as const) {
    vi.spyOn(fs.promises, "stat").mockImplementation(async (name) => {
      if (name === root && failure === "missing") throw new Error("root removed");
      const stat = await originalStat(
        name === root && failure === "file" ? path.join(root, "README.md") : name,
        { bigint: true },
      );
      if (name === root && failure === "device") stat.dev += 1n;
      if (name === root && failure === "inode") stat.ino += 1n;
      return stat;
    });
    expect(await readInside(captured, "/README.md")).toEqual(
      failure === "missing"
        ? { status: 404, reason: "unreadable" }
        : { status: 403, reason: "escape" },
    );
  }
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(4);
});

test.each(["darwin", "win32"] as const)(
  "%s checks the re-resolved file identity exactly before reading",
  async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const originalStat = fs.promises.stat;
    const originalFstat = io.fstat;
    const read = vi.spyOn(io, "read");
    const close = vi.spyOn(io, "close");
    const file = path.join(root, "README.md");
    const inode = 2n ** 60n;
    vi.spyOn(io, "fstat").mockImplementation(async (fd) => {
      const stat = await originalFstat(fd);
      stat.ino = inode;
      return stat;
    });
    for (const failure of ["missing", "file", "device", "inode"] as const) {
      let stats = 0;
      vi.spyOn(fs.promises, "stat").mockImplementation(async (name) => {
        const verifying = name === file && ++stats === 3;
        if (verifying && failure === "missing") throw new Error("target removed");
        const stat = await originalStat(verifying && failure === "file" ? root : name, {
          bigint: true,
        });
        if (name === file) stat.ino = inode;
        if (verifying && failure === "device") stat.dev += 1n;
        if (verifying && failure === "inode") stat.ino += 1n;
        return stat;
      });
      expect(await readInside(captured, "/README.md")).toEqual(
        failure === "missing"
          ? { status: 404, reason: "unreadable" }
          : { status: 403, reason: "not-file" },
      );
    }
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(4);
  },
);

test.skipIf(!links || openFlags({ O_RDONLY: 0, O_NOFOLLOW: fs.constants.O_NOFOLLOW }) === 0)(
  "does not follow a final symlink inserted after stat",
  async () => {
    const originalOpen = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags, mode) => {
      fs.unlinkSync(path.join(root, "README.md"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "README.md"));
      return originalOpen(file, flags, mode);
    });
    expect(await openInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
  },
);

test.skipIf(!links)("keeps the canonical root captured before a root path swap", async () => {
  fs.renameSync(root, `${root}-old`);
  fs.symlinkSync(outside, root, "dir");
  expect(await openInside(captured, "/secret.txt")).toEqual({ status: 403, reason: "escape" });
});

test.skipIf(process.platform === "win32" || !links)(
  "rechecks Windows alias targets even on POSIX",
  async () => {
    fs.writeFileSync(path.join(root, "alias.txt."), "alias");
    fs.symlinkSync(path.join(root, "alias.txt."), path.join(root, "safe.txt"));
    expect(await openInside(captured, "/safe.txt")).toEqual({
      status: 403,
      reason: "target-windows-trailing",
    });
  },
);

test("records served targets, requested names and missing directory indexes, but not refused requests", async () => {
  const record = vi.fn();
  const origin = "foom-preview://id";
  await readPreview(captured, origin + "/docs/page.html", origin, record);
  expect(record).toHaveBeenCalledWith(path.join(root, "docs", "page.html"));
  record.mockClear();
  await readPreview(captured, origin + "/docs/assets/", origin, record);
  expect(record).toHaveBeenCalledWith(path.join(root, "docs", "assets", "index.html"));
  record.mockClear();
  await readPreview(captured, origin + "/.env", origin, record);
  await readPreview(captured, "foom-preview://other/a", origin, record);
  expect(record).not.toHaveBeenCalled();
});

test("continues partial reads but never reads beyond the checked size if a file grows", async () => {
  const read = io.read;
  let appended = false;
  vi.spyOn(io, "read").mockImplementation(async (fd, buffer, offset, length, position) => {
    if (!appended) {
      appended = true;
      await fs.promises.appendFile(path.join(root, "README.md"), "extra");
    }
    return read(fd, buffer, offset, Math.min(length, 2), position);
  });
  const close = vi.spyOn(io, "close");
  expect(await body("/README.md")).toBe("# readme");
  expect(io.read).toHaveBeenCalledTimes(4);
  expect(close).toHaveBeenCalledOnce();
});
