import type * as FileSystem from "node:fs/promises";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSetupSources } from "../../../src/node-common/repository-setup-sources";
import { setupCatalogDigest, setupDigest } from "../../../src/node-common/repository-setup-digest";
let root: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(open).mockImplementation(actual.open);
  root = await mkdtemp(join(tmpdir(), "repository-sources-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const write = async (path: string, text: string) => {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, text);
};
describe("bounded repository evidence", () => {
  it("tracks dirty and untracked monorepo membership independently of HEAD", async () => {
    await write("package.json", "one");
    await write(".github/workflows/ci.yml", "workflow");
    const first = await inspectSetupSources(root, []);
    await write(".git/HEAD", "a new commit with unchanged evidence");
    expect(await inspectSetupSources(root, [])).toEqual(first);
    await write("packages/new/package.json", "untracked");
    const added = await inspectSetupSources(root, []);
    expect(added.fingerprint).not.toBe(first.fingerprint);
    expect(added.files.map((file) => file.path)).toContain("packages/new/package.json");
    await write("package.json", "dirty");
    expect((await inspectSetupSources(root, [])).fingerprint).not.toBe(added.fingerprint);
    await rm(join(root, "packages"), { recursive: true });
    expect((await inspectSetupSources(root, [])).fingerprint).not.toBe(added.fingerprint);
    await write("notes.md", "unrelated");
    const notes = await inspectSetupSources(root, ["notes.md"]);
    expect(notes.files.map((file) => file.path)).toContain("notes.md");
  });
  it("ignores dependency and reference trees while retaining explicit evidence", async () => {
    await write("node_modules/a/package.json", "ignored");
    await write("docs/mockups/a/package.json", "ignored");
    await write("inspiration/a/package.json", "ignored");
    expect((await inspectSetupSources(root, [])).files).toEqual([]);
    expect(setupCatalogDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(setupDigest(["a", "b"])).not.toBe(setupDigest(["b", "a"]));
  });
  it("refuses escapes, symlinks and absent evidence", async () => {
    for (const paths of [
      ["../secret"],
      ["missing"],
      Array.from({ length: 65 }, (_, i) => `file-${String(i)}`),
    ])
      await expect(inspectSetupSources(root, paths)).rejects.toThrow();
    await write("actual", "bytes");
    await symlink(join(root, "actual"), join(root, "package.json"));
    await expect(inspectSetupSources(root, [])).rejects.toThrow();
    await rm(join(root, "package.json"));
    await symlink(root, join(root, "linked"), "dir");
    await expect(inspectSetupSources(root, [])).rejects.toThrow();
  });
  it("refuses too many matching files and oversized individual or aggregate bytes", async () => {
    for (let i = 0; i < 65; i++) await write(`p${String(i)}/package.json`, "{}");
    await expect(inspectSetupSources(root, [])).rejects.toThrow();
    await rm(root, { recursive: true });
    await write("package.json", "x".repeat(1048577));
    await expect(inspectSetupSources(root, [])).rejects.toThrow();
    await write("package.json", "x".repeat(1048576));
    for (let i = 0; i < 4; i++) await write(`p${String(i)}/package.json`, "x".repeat(1048576));
    await expect(inspectSetupSources(root, [])).rejects.toThrow();
  });
});

it("refuses a source replaced between path validation and opening its file handle", async () => {
  await write("package.json", "old bytes");
  const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    await rename(join(root, "package.json"), join(root, "old.json"));
    await write("package.json", "new bytes");
    return actual.open(...args);
  });
  await expect(inspectSetupSources(root, [])).rejects.toThrow("Unable to verify sources");
});
