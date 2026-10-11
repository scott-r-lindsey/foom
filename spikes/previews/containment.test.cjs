"use strict";
// node --test spikes/previews/containment.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalRoot, openInside, readInside, segmentsFor } = require("./containment.cjs");

// What the WHATWG parser hands the protocol handler for a standard scheme.
const pathOf = (raw) => new URL(raw, "foom-preview://0123abcd/").pathname;

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foom-preview-containment-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "worktree");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "docs", "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "docs", "page.html"), "<p>page</p>");
  fs.writeFileSync(path.join(root, "docs", "assets", "a.css"), "p{}");
  fs.writeFileSync(path.join(root, "docs", "index.html"), "index");
  fs.writeFileSync(path.join(root, "README.md"), "# readme");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
  // A sibling whose name shares the root's prefix catches naive startsWith checks.
  fs.mkdirSync(`${root}-evil`);
  fs.writeFileSync(path.join(`${root}-evil`, "x.txt"), "sibling");
  return { base, root: canonicalRoot(root), outside };
}

const symlinks = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "foom-preview-link-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "l"), "dir");
    return true;
  } catch {
    return false; // Windows without Developer Mode
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

test("serves files and relative assets inside the worktree", (t) => {
  const { root } = fixture(t);
  const page = readInside(root, pathOf("/docs/page.html"));
  assert.equal(page.status, 200);
  assert.equal(page.type, "text/html; charset=utf-8");
  assert.equal(page.body.toString(), "<p>page</p>");
  const asset = readInside(root, new URL("assets/a.css", "foom-preview://id/docs/page.html").pathname);
  assert.equal(asset.status, 200);
  assert.equal(asset.type, "text/css; charset=utf-8");
  assert.equal(readInside(root, pathOf("/docs/")).body.toString(), "index");
  assert.equal(readInside(root, pathOf("/docs/missing.html")).status, 404);
});

test("URL normalization removes dot segments before the handler sees them", () => {
  for (const raw of [
    "/../../etc/passwd",
    "/docs/../../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/%2E%2E/etc/passwd",
    "/.%2e/etc/passwd",
  ])
    assert.ok(!pathOf(raw).includes(".."), raw);
});

test("refuses encoded separators, dot segments, NUL and hidden names", (t) => {
  const { root } = fixture(t);
  const cases = {
    "/..%2f..%2fetc%2fpasswd": "separator",
    "/..%5c..%5cetc%5cpasswd": "separator",
    "/docs%2fpage.html": "separator",
    "/docs/page.html%00.png": "separator",
    "/%2e%2e%2f": "separator",
    "/.env": "hidden",
    "/.git/config": "hidden",
    "/docs/%2e%2e%5c": "separator",
    "/bad%E0%A4%A": "bad-encoding",
    "/a%0ab": "control",
  };
  for (const [raw, reason] of Object.entries(cases)) {
    const result = openInside(root, pathOf(raw));
    assert.equal(result.status, 400, raw);
    assert.equal(result.reason, reason, raw);
  }
  assert.equal(segmentsFor("/a//b").error, "dot-segment");
  assert.equal(segmentsFor("relative").error, "not-absolute");
  assert.equal(segmentsFor(`/${"a/".repeat(70)}`).error, "too-deep");
});

test("applies Windows path-form rules", () => {
  const win = (p) => segmentsFor(p, "win32").error;
  assert.equal(win("/C:/Windows/win.ini"), "windows-colon");
  assert.equal(win("/C%3A%5CWindows"), "separator");
  assert.equal(win("/page.html::$DATA"), "windows-colon");
  assert.equal(win("/page.html."), "windows-trailing");
  assert.equal(win("/page.html%20"), "windows-trailing");
  assert.equal(win("/CON"), "windows-device");
  assert.equal(win("/nul.txt"), "windows-device");
  assert.equal(win("/COM1.md"), "windows-device");
  assert.equal(win("/a%3Fb"), "windows-reserved");
  assert.equal(win("/%5C%5C%3F%5CC%3A%5Cx"), "separator"); // \\?\C:\x
  assert.equal(win("/%5C%5Cserver%5Cshare"), "separator"); // UNC
  assert.equal(win("/docs/page.html"), undefined);
  // The same names are ordinary files elsewhere.
  assert.equal(segmentsFor("/page.html.", "linux").error, undefined);
});

test("refuses symlinks that escape and allows ones that stay inside", { skip: !symlinks }, (t) => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, "escape-dir"), "dir");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));
  fs.symlinkSync(`${root}-evil`, path.join(root, "prefix-sibling"), "dir");
  fs.symlinkSync(path.join(root, "README.md"), path.join(root, "inside-link.md"));
  fs.symlinkSync(path.join(root, ".env"), path.join(root, "env-link.txt"));
  fs.symlinkSync(path.join(root, ".git"), path.join(root, "git-link"), "dir");
  fs.symlinkSync("/", path.join(root, "slash"), "dir");
  fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
  fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
  assert.equal(openInside(root, "/escape-dir/secret.txt").reason, "escape");
  assert.equal(openInside(root, "/escape-file.txt").reason, "escape");
  assert.equal(openInside(root, "/prefix-sibling/x.txt").reason, "escape");
  assert.equal(openInside(root, "/slash/etc/hostname").status, 403);
  assert.equal(openInside(root, "/env-link.txt").reason, "target-hidden");
  assert.equal(openInside(root, "/git-link/config").reason, "target-hidden");
  assert.equal(openInside(root, "/loop-a").status, 404);
  const inside = readInside(root, "/inside-link.md");
  assert.equal(inside.status, 200);
  assert.equal(inside.body.toString(), "# readme");
});

test("refuses a worktree root that is itself reached through a parent symlink swap", { skip: !symlinks }, (t) => {
  const { base, root, outside } = fixture(t);
  // The handler keeps the canonical root captured at open time; replacing a
  // directory inside it with a link to the outside is caught on the next request.
  fs.rmSync(path.join(root, "docs"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "docs"), "dir");
  assert.equal(openInside(root, "/docs/secret.txt").reason, "escape");
  assert.ok(base);
});

test("Windows junctions that escape are refused", { skip: process.platform !== "win32" }, (t) => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, "junction"), "junction");
  assert.equal(openInside(root, "/junction/secret.txt").reason, "escape");
});

test("case-insensitive volumes cannot widen the root", (t) => {
  const { root } = fixture(t);
  // Prefix comparison is byte-exact on realpaths, so a differently cased
  // sibling never counts as inside, even where the volume would accept it.
  const upper = path.join(path.dirname(root), path.basename(root).toUpperCase());
  assert.equal(require("./containment.cjs").inside(root, path.join(upper, "x")), false);
  assert.equal(require("./containment.cjs").inside(root, `${root}-evil`), false);
  assert.equal(require("./containment.cjs").inside(root, path.join(root, "x")), true);
});

test("enforces size limits and refuses non-files", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(root, "big.md"), "x".repeat(2048));
  assert.equal(openInside(root, "/big.bin", { maxBytes: 1024 }).status, 413);
  assert.equal(openInside(root, "/big.md", { maxMarkdownBytes: 1024 }).status, 413);
  assert.equal(openInside(root, "/big.bin", { maxBytes: 4096 }).status, 200);
  // A directory without index.html is not served.
  assert.equal(openInside(root, "/docs/assets/").status, 404);
  if (process.platform !== "win32") {
    const fifo = path.join(root, "pipe");
    try {
      require("node:child_process").execFileSync("mkfifo", [fifo]);
      assert.equal(openInside(root, "/pipe").reason, "not-file"); // never opened, so it cannot block
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});

test("unknown types are served as octet-stream", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "data.xyz"), "x");
  assert.equal(readInside(root, "/data.xyz").type, "application/octet-stream");
});
