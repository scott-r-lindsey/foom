import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  canonicalRoot,
  openFlags,
  openInside,
  readInside,
  readPreview,
} from "../../../../src/main/previews/contained-files";
import { MAX_FILE_BYTES, MAX_MARKDOWN_BYTES } from "../../../../src/main/previews/policy";

let base: string;
let root: string;
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
  root = canonicalRoot(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function body(pathname: string): string {
  const result = readInside(root, pathname);
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
  const opened = openInside(root, "/README.md");
  if (opened.status !== 200) throw new Error(opened.reason);
  try {
    expect(fs.readFileSync(opened.fd, "utf8")).toBe("# readme");
    expect(opened.relative).toBe("README.md");
  } finally {
    fs.closeSync(opened.fd);
  }
  expect(readInside(root, "/missing")).toEqual({ status: 404, reason: "missing" });
  expect(readInside(root, "/docs/assets/").status).toBe(404);
  expect(readInside(root, "/.env")).toEqual({ status: 400, reason: "hidden" });
  expect(() => canonicalRoot(path.join(root, "README.md"))).toThrow("not a directory");
});

test("adapts hostile URLs and attaches headers to success and refusal", () => {
  const good = readPreview(root, "foom-preview://id/docs/page.html", "foom-preview://id");
  expect(good.status).toBe(200);
  expect(good.headers["x-content-type-options"]).toBe("nosniff");
  for (const url of [
    "foom-preview://id/../../../../etc/hostname",
    "foom-preview://id/%2e%2e/etc/hostname",
  ])
    expect(readPreview(root, url, "foom-preview://id").status).toBe(404);
  expect(
    readPreview(root, "foom-preview://id/..%2f..%2fetc%2fhostname", "foom-preview://id").status,
  ).toBe(400);
  const bad = readPreview(root, {}, "foom-preview://id");
  expect(bad.status).toBe(400);
  expect(bad.headers["cache-control"]).toBe("no-store");
  expect(readPreview(root, "foom-preview://other/a", "foom-preview://id").status).toBe(403);
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
      expect(openInside(root, pathname)).toEqual({ status: 403, reason: "escape" });
    for (const pathname of ["/env-link.txt", "/git-link/config"])
      expect(openInside(root, pathname)).toEqual({ status: 403, reason: "target-hidden" });
    expect(openInside(root, "/loop-a").status).toBe(404);
    expect(body("/inside-link.md")).toBe("# readme");
    fs.rmSync(path.join(root, "docs"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "docs"), "dir");
    expect(openInside(root, "/docs/secret.txt")).toEqual({ status: 403, reason: "escape" });
  },
);

test.skipIf(process.platform !== "win32")(
  "refuses Windows junction escapes and hidden targets",
  () => {
    fs.symlinkSync(outside, path.join(root, "junction"), "junction");
    expect(openInside(root, "/junction/secret.txt")).toEqual({ status: 403, reason: "escape" });
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "hidden-junction"), "junction");
    expect(openInside(root, "/hidden-junction/config")).toEqual({
      status: 403,
      reason: "target-hidden",
    });
  },
);

test.skipIf(!links)("checks a directory's index realpath for escapes", () => {
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "index.html"));
  expect(openInside(root, "/")).toEqual({ status: 403, reason: "escape" });
});

test("enforces limits at the descriptor and refuses non-files", () => {
  for (const [name, size] of [
    ["big.bin", MAX_FILE_BYTES],
    ["big.md", MAX_MARKDOWN_BYTES],
  ] as const) {
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.alloc(size));
    expect(readInside(root, `/${name}`).status).toBe(200);
    fs.appendFileSync(file, "x");
    expect(openInside(root, `/${name}`)).toEqual({ status: 413, reason: "too-large" });
  }
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(openInside(root, "/pipe")).toEqual({ status: 403, reason: "not-file" });
  }
  fs.writeFileSync(path.join(root, "data.xyz"), "x");
  const unknown = readInside(root, "/data.xyz");
  expect(unknown).toHaveProperty("type", "application/octet-stream");
});

test("closes handles on replacement, open/stat failures and bounded short reads", () => {
  const fstat = fs.fstatSync;
  const close = vi.spyOn(fs, "closeSync");
  vi.spyOn(fs, "fstatSync").mockImplementationOnce((fd) => {
    const stat = fstat(fd);
    stat.ino += 1;
    return stat;
  });
  expect(openInside(root, "/README.md")).toEqual({ status: 403, reason: "not-file" });
  expect(close).toHaveBeenCalledTimes(1);
  vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
    throw new Error("unreadable");
  });
  expect(openInside(root, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
  expect(close).toHaveBeenCalledTimes(2);
  vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
    throw new Error("denied");
  });
  expect(openInside(root, "/README.md").status).toBe(404);
  vi.spyOn(fs, "readSync").mockReturnValueOnce(0);
  expect(body("/README.md")).toBe("");
  expect(close).toHaveBeenCalledTimes(3);
  vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
    throw new Error("read failure");
  });
  expect(() => body("/README.md")).toThrow("read failure");
  expect(close).toHaveBeenCalledTimes(4);
});

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
  expect(openInside(root, "/README.md")).toEqual({ status: 403, reason: "not-file" });
});

test.skipIf(!links || openFlags({ O_RDONLY: 0, O_NOFOLLOW: fs.constants.O_NOFOLLOW }) === 0)(
  "does not follow a final symlink inserted after stat",
  () => {
    const originalOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags, mode) => {
      fs.unlinkSync(path.join(root, "README.md"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "README.md"));
      return originalOpen(file, flags, mode);
    });
    expect(openInside(root, "/README.md")).toEqual({ status: 404, reason: "unreadable" });
  },
);

test.skipIf(!links)("keeps the canonical root captured before a root path swap", () => {
  fs.renameSync(root, `${root}-old`);
  fs.symlinkSync(outside, root, "dir");
  expect(openInside(root, "/secret.txt")).toEqual({ status: 403, reason: "escape" });
});

test.skipIf(process.platform === "win32" || !links)(
  "rechecks Windows alias targets even on POSIX",
  () => {
    fs.writeFileSync(path.join(root, "alias.txt."), "alias");
    fs.symlinkSync(path.join(root, "alias.txt."), path.join(root, "safe.txt"));
    expect(openInside(root, "/safe.txt")).toEqual({
      status: 403,
      reason: "target-windows-trailing",
    });
  },
);
