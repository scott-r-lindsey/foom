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

let base: string;
let root: string;
let captured: CanonicalRoot;
let outside: string;
beforeEach(() => {
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

function body(pathname: string): string {
  const result = readInside(captured, pathname);
  if (result.status !== 200) throw new Error(result.reason);
  return result.body.toString();
}

test("serves pages, relative assets and directory indexes from owned handles", () => {
  expect(body("/docs/page.html")).toBe("<p>page</p>");
  expect(body(new URL("assets/a.css", "foom-preview://id/docs/page.html").pathname)).toBe("p{}");
  expect(body("/docs/")).toBe("index");
  expect(body("/docs")).toBe("index");
  fs.writeFileSync(path.join(root, "index.html"), "root index");
  expect(body("/")).toBe("root index");
  const opened = openInside(captured, "/README.md");
  if (opened.status !== 200) throw new Error(opened.reason);
  try {
    expect(fs.readFileSync(opened.fd, "utf8")).toBe("# readme");
    expect(opened.relative).toBe("README.md");
  } finally {
    fs.closeSync(opened.fd);
  }
  expect(readInside(captured, "/missing")).toEqual({ status: 404, reason: "missing" });
  expect(readInside(captured, "/docs/assets/").status).toBe(404);
  expect(readInside(captured, "/.env")).toEqual({ status: 400, reason: "hidden" });
  expect(() => canonicalRoot(path.join(root, "README.md"))).toThrow("not a directory");
});

test("adapts hostile URLs and attaches headers to success and refusal", () => {
  const good = readPreview(captured, "foom-preview://id/docs/page.html", "foom-preview://id");
  expect(good.status).toBe(200);
  expect(good.headers["x-content-type-options"]).toBe("nosniff");
  for (const url of [
    "foom-preview://id/../../../../etc/hostname",
    "foom-preview://id/%2e%2e/etc/hostname",
  ])
    expect(readPreview(captured, url, "foom-preview://id").status).toBe(404);
  expect(
    readPreview(captured, "foom-preview://id/..%2f..%2fetc%2fhostname", "foom-preview://id").status,
  ).toBe(400);
  const bad = readPreview(captured, {}, "foom-preview://id");
  expect(bad.status).toBe(400);
  expect(bad.headers["cache-control"]).toBe("no-store");
  expect(readPreview(captured, "foom-preview://other/a", "foom-preview://id").status).toBe(403);
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
  () => {
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
      expect(openInside(captured, pathname)).toEqual({ status: 403, reason: "escape" });
    for (const pathname of ["/env-link.txt", "/git-link/config"])
      expect(openInside(captured, pathname)).toEqual({ status: 403, reason: "target-hidden" });
    expect(openInside(captured, "/loop-a").status).toBe(404);
    expect(body("/inside-link.md")).toBe("# readme");
    fs.rmSync(path.join(root, "docs"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "docs"), "dir");
    expect(openInside(captured, "/docs/secret.txt")).toEqual({ status: 403, reason: "escape" });
  },
);

test.skipIf(process.platform !== "win32")(
  "refuses Windows junction escapes and hidden targets",
  () => {
    fs.symlinkSync(outside, path.join(root, "junction"), "junction");
    expect(openInside(captured, "/junction/secret.txt")).toEqual({ status: 403, reason: "escape" });
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "hidden-junction"), "junction");
    expect(openInside(captured, "/hidden-junction/config")).toEqual({
      status: 403,
      reason: "target-hidden",
    });
  },
);

test.skipIf(!links)("checks a directory's index realpath for escapes", () => {
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "index.html"));
  expect(openInside(captured, "/")).toEqual({ status: 403, reason: "escape" });
});

test("enforces limits at the descriptor and refuses non-files", () => {
  for (const [name, size] of [
    ["big.bin", MAX_FILE_BYTES],
    ["big.md", MAX_MARKDOWN_BYTES],
  ] as const) {
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.alloc(size));
    expect(readInside(captured, `/${name}`).status).toBe(200);
    fs.appendFileSync(file, "x");
    expect(openInside(captured, `/${name}`)).toEqual({ status: 413, reason: "too-large" });
  }
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(openInside(captured, "/pipe")).toEqual({ status: 403, reason: "not-file" });
  }
  fs.writeFileSync(path.join(root, "data.xyz"), "x");
  const unknown = readInside(captured, "/data.xyz");
  expect(unknown).toHaveProperty("type", "application/octet-stream");
});

test.each([1, 2 ** 60])(
  "closes handles on replacement, open/stat failures and bounded short reads (inode %s)",
  (inode) => {
    const namedStat = fs.statSync;
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "statSync").mockImplementation((name) => {
      const stat = namedStat(name, { bigint: true });
      if (name !== root) stat.ino = BigInt(inode);
      return stat;
    });
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd, { bigint: true });
      stat.ino = BigInt(inode);
      return stat;
    });
    const close = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "fstatSync").mockImplementationOnce((fd) => {
      const stat = fstat(fd, { bigint: true });
      // A one-unit increment can round away for large Windows inode values.
      stat.ino = inode === 0 ? 1n : 0n;
      return stat;
    });
    expect(openInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
    expect(close).toHaveBeenCalledTimes(1);
    vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    expect(openInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
    expect(close).toHaveBeenCalledTimes(2);
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw new Error("denied");
    });
    expect(openInside(captured, "/README.md").status).toBe(404);
    vi.spyOn(fs, "readSync").mockReturnValueOnce(0);
    expect(body("/README.md")).toBe("");
    expect(close).toHaveBeenCalledTimes(3);
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
      throw new Error("read failure");
    });
    expect(() => body("/README.md")).toThrow("read failure");
    expect(close).toHaveBeenCalledTimes(4);
  },
);

test("handles absent POSIX flags explicitly", () => {
  expect(openFlags({ O_RDONLY: 1 })).toBe(1);
  expect(openFlags({ O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 })).toBe(7);
});

test("refuses a final file replaced between stat and open", () => {
  const originalOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags, mode) => {
    fs.renameSync(path.join(root, "README.md"), path.join(root, "old.md"));
    fs.writeFileSync(path.join(root, "README.md"), "replacement");
    return originalOpen(file, flags, mode);
  });
  expect(openInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
});

test.each(["ancestor", "root"] as const)(
  "refuses a %s replaced after resolution but before the later stat",
  (replacement) => {
    fs.mkdirSync(path.join(outside, "docs"));
    fs.writeFileSync(path.join(outside, "page.html"), "outside secret");
    fs.writeFileSync(path.join(outside, "docs", "page.html"), "outside secret");
    const originalStat = fs.statSync;
    const file = path.join(root, "docs", "page.html");
    let stats = 0;
    vi.spyOn(fs, "statSync").mockImplementation((name) => {
      if (name === file && ++stats === 2) {
        // The first stat handles directory-index selection. At the later stat,
        // the earlier realpath and containment checks have already succeeded.
        const ancestor = replacement === "root" ? root : path.join(root, "docs");
        fs.renameSync(ancestor, `${ancestor}-old`);
        fs.symlinkSync(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
      }
      return originalStat(name, { bigint: true });
    });
    const read = vi.spyOn(fs, "readSync");
    expect(readInside(captured, "/docs/page.html")).toEqual({ status: 403, reason: "escape" });
    expect(stats).toBeGreaterThanOrEqual(2);
    expect(read).not.toHaveBeenCalled();
  },
);

const platforms = ["linux", "darwin", "win32"] as const;

/** Exercise both OS strategies on every host; native suites also run on each OS. */
function verification(platform: NodeJS.Platform, resolve: () => string): void {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "linux") {
    vi.spyOn(fs, "readlinkSync").mockImplementation(resolve);
  } else {
    const realpath = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, "native")
      .mockImplementationOnce((file) => realpath(file))
      .mockImplementation(resolve);
  }
}

test.each(platforms)("%s serves a verified descriptor with the captured root", (platform) => {
  verification(platform, () => path.join(root, "README.md"));
  expect(body("/README.md")).toBe("# readme");
});

test("refuses an ordinary replacement directory at the captured root's spelling", () => {
  fs.renameSync(root, `${root}-old`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "replacement secret");
  const read = vi.spyOn(fs, "readSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(readInside(captured, "/README.md")).toEqual({ status: 403, reason: "escape" });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(["directory", "device"] as const)(
  "refuses descriptor %s mismatches before post-open verification",
  (failure) => {
    const originalFstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat =
        failure === "directory"
          ? fs.statSync(root, { bigint: true })
          : originalFstat(fd, { bigint: true });
      if (failure === "device") stat.dev += 1n;
      return stat;
    });
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    expect(readInside(captured, "/README.md")).toEqual({ status: 403, reason: "not-file" });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

test.each(platforms)("%s closes without reading if post-open resolution fails", (platform) => {
  verification(platform, () => {
    throw new Error("unavailable (including missing procfs)");
  });
  const read = vi.spyOn(fs, "readSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(readInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(platforms)("%s rechecks post-open containment and forbidden names", (platform) => {
  const read = vi.spyOn(fs, "readSync");
  const close = vi.spyOn(fs, "closeSync");
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
      vi.mocked(fs.realpathSync.native)
        .mockReset()
        .mockReturnValueOnce(path.join(root, "README.md"))
        .mockImplementation(() => target);
    expect(readInside(captured, "/README.md")).toEqual({ status: 403, reason });
  }
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(5);
});

test.each(platforms)("%s refuses a changed or unavailable captured root", (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "linux")
    vi.spyOn(fs, "readlinkSync").mockReturnValue(path.join(root, "README.md"));
  const originalStat = fs.statSync;
  const read = vi.spyOn(fs, "readSync");
  const close = vi.spyOn(fs, "closeSync");
  for (const failure of ["missing", "file", "device", "inode"] as const) {
    vi.spyOn(fs, "statSync").mockImplementation((name) => {
      if (name === root && failure === "missing") throw new Error("root removed");
      const stat = originalStat(
        name === root && failure === "file" ? path.join(root, "README.md") : name,
        { bigint: true },
      );
      if (name === root && failure === "device") stat.dev += 1n;
      if (name === root && failure === "inode") stat.ino += 1n;
      return stat;
    });
    expect(readInside(captured, "/README.md")).toEqual(
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
  (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const originalStat = fs.statSync;
    const originalFstat = fs.fstatSync;
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    const file = path.join(root, "README.md");
    const inode = 2n ** 60n;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = originalFstat(fd, { bigint: true });
      stat.ino = inode;
      return stat;
    });
    for (const failure of ["missing", "file", "device", "inode"] as const) {
      let stats = 0;
      vi.spyOn(fs, "statSync").mockImplementation((name) => {
        const verifying = name === file && ++stats === 3;
        if (verifying && failure === "missing") throw new Error("target removed");
        const stat = originalStat(verifying && failure === "file" ? root : name, {
          bigint: true,
        });
        if (name === file) stat.ino = inode;
        if (verifying && failure === "device") stat.dev += 1n;
        if (verifying && failure === "inode") stat.ino += 1n;
        return stat;
      });
      expect(readInside(captured, "/README.md")).toEqual(
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
  () => {
    const originalOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags, mode) => {
      fs.unlinkSync(path.join(root, "README.md"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "README.md"));
      return originalOpen(file, flags, mode);
    });
    expect(openInside(captured, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
  },
);

test.skipIf(!links)("keeps the canonical root captured before a root path swap", () => {
  fs.renameSync(root, `${root}-old`);
  fs.symlinkSync(outside, root, "dir");
  expect(openInside(captured, "/secret.txt")).toEqual({ status: 403, reason: "escape" });
});

test.skipIf(process.platform === "win32" || !links)(
  "rechecks Windows alias targets even on POSIX",
  () => {
    fs.writeFileSync(path.join(root, "alias.txt."), "alias");
    fs.symlinkSync(path.join(root, "alias.txt."), path.join(root, "safe.txt"));
    expect(openInside(captured, "/safe.txt")).toEqual({
      status: 403,
      reason: "target-windows-trailing",
    });
  },
);

test("records served targets, requested names and missing directory indexes, but not refused requests", () => {
  const record = vi.fn();
  const origin = "foom-preview://id";
  readPreview(captured, origin + "/docs/page.html", origin, record);
  expect(record).toHaveBeenCalledWith(path.join(root, "docs", "page.html"));
  record.mockClear();
  readPreview(captured, origin + "/docs/assets/", origin, record);
  expect(record).toHaveBeenCalledWith(path.join(root, "docs", "assets", "index.html"));
  record.mockClear();
  readPreview(captured, origin + "/.env", origin, record);
  readPreview(captured, "foom-preview://other/a", origin, record);
  expect(record).not.toHaveBeenCalled();
});
