import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  parseRegistry,
  previewId,
  previewPath,
  PreviewRegistry,
} from "../../../../src/main/previews/registry";
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-registry-"));
  folders.push(root);
  return join(root, "profile", "previews.json");
}
const record = {
  id: "a".repeat(32),
  worktree: "/repo",
  relativePath: "docs/plan.md",
  network: false,
};
test("only opaque IDs and contained preview document paths are valid", () => {
  expect(previewId(record.id)).toBe(true);
  for (const value of [null, 1, "", "a".repeat(31), "g".repeat(32)])
    expect(previewId(value)).toBe(false);
  expect(previewPath("docs/a b.HTML")).toBe(true);
  for (const value of [
    null,
    1,
    "",
    "/a.html",
    "../a.html",
    ".git/a.html",
    "CON.html",
    "a\\b.html",
    "a.css",
    "a".repeat(1025) + ".html",
  ])
    expect(previewPath(value)).toBe(false);
});
test("untrusted stored records fail closed and duplicate IDs are dropped", () => {
  for (const value of [null, {}, Array.from({ length: 257 }, () => record)])
    expect(parseRegistry(value)).toEqual([]);
  const bad = [
    null,
    {},
    { ...record, extra: 1 },
    { ...record, id: 1 },
    { ...record, worktree: 1 },
    { ...record, worktree: "" },
    { ...record, worktree: "a".repeat(4097) },
    { ...record, worktree: "\0" },
    { ...record, relativePath: "../a.md" },
    { ...record, network: true },
  ];
  expect(parseRegistry([...bad, record, record])).toEqual([record]);
});
test("persists per-window path records with ordered atomic writes and tolerates corrupt/missing data", async () => {
  const file = await fixture();
  const registry = new PreviewRegistry(file);
  await registry.load();
  expect(registry.records.size).toBe(0);
  const a = registry.add("/repo", "a.html");
  expect(previewId(a.id)).toBe(true);
  const first = registry.save();
  registry.add("/repo", "b.md");
  await Promise.all([first, registry.save()]);
  const restored = new PreviewRegistry(file);
  await restored.load();
  expect([...restored.records.values()]).toEqual([...registry.records.values()]);
  expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);
  await writeFile(file, "not json");
  await new PreviewRegistry(file).load();
  await writeFile(file, " ".repeat(1024 * 1024 + 1));
  const oversized = new PreviewRegistry(file);
  await oversized.load();
  expect(oversized.records.size).toBe(0);
  registry.records.clear();
  for (let i = 0; i < 256; i++) registry.add("/repo", "a.md");
  expect(() => registry.add("/repo", "a.md")).toThrow("capacity");
});
test("a failed persistence write does not poison later writes", async () => {
  const file = await fixture();
  const registry = new PreviewRegistry(file);
  const parent = join(file, "..");
  // A regular file at the profile directory prevents mkdir, then recovery permits save.
  const root = join(parent, "..");
  await writeFile(join(root, "profile"), "blocked");
  await expect(registry.save()).rejects.toThrow();
  await rm(parent);
  registry.add("/repo", "a.md");
  await registry.save();
});
