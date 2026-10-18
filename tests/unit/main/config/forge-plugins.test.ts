import { validateConfig } from "../../../../src/cli/config";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigService } from "../../../../src/main/config/service";
import type { LoadedForgeManifest } from "../../../../src/main/config/plugins";
import { configPart } from "../../../../src/main/config/approval";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import github from "../../../../src/shared/bundled-forges/github.json";
import agent from "../../../fixtures/agent-plugin.json";

const roots: string[] = [];
const services: ConfigService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-config-forges-"));
  roots.push(root);
  const watches = new Map<
    string,
    { listener: (file: string | null) => void; close: ReturnType<typeof vi.fn> }
  >();
  let catalog: readonly LoadedForgeManifest[] = [];
  const applyForges = vi.fn((plugins: readonly LoadedForgeManifest[]) => {
    catalog = plugins;
  });
  const service = new ConfigService({
    root,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: vi.fn(),
    baseline: { get: () => null, set: () => Promise.resolve() },
    themeBaseline: { get: () => null, set: () => Promise.resolve() },
    applyForges,
    delay: 1,
    watch: (folder, listener) => {
      const close = vi.fn();
      watches.set(folder, { listener, close });
      return { close };
    },
  });
  services.push(service);
  await service.initialize();
  return {
    root,
    service,
    watches,
    applyForges,
    catalog: () => catalog,
    file: join(root, "forges", "custom.json"),
  };
}
const source = JSON.stringify({ ...github, id: "custom" });
function first(catalog: readonly LoadedForgeManifest[]): LoadedForgeManifest {
  const entry = catalog[0];
  if (!entry) throw new Error("Missing forge");
  return entry;
}
it("loads through the shared bounded scanner, binds exact bytes, reloads edits and retires removed definitions", async () => {
  const f = await fixture();
  await writeFile(f.file, source);
  expect((await f.service.refresh()).pending).toBeNull();
  expect(await validateConfig(f.root)).toEqual({ problems: [], code: 0 });
  expect(await validateConfig(join(f.root, "forges"))).toEqual({ problems: [], code: 0 });
  expect(await validateConfig(f.file)).toEqual({ problems: [], code: 0 });
  await writeFile(
    join(f.root, "agents", "custom.json"),
    JSON.stringify({ ...agent, id: "custom" }),
  );
  expect((await f.service.refresh()).rejected).toEqual([]);
  const initial = first(f.catalog());
  expect(initial.manifest.id).toBe("custom");
  expect(f.service.status().forgePlugins).toEqual([
    { id: "github", name: "GitHub", badge: "GH", executables: ["gh"] },
    { id: "custom", name: "GitHub", badge: "GH", executables: ["gh"], file: "forges/custom.json" },
  ]);
  expect(initial.digest).toMatch(/^[a-f0-9]{64}$/u);
  await expect(initial.validate()).resolves.toBeUndefined();
  await f.service.refresh();
  expect(first(f.catalog())).toBe(initial);
  await writeFile(f.file, source + " ");
  await expect(initial.validate()).rejects.toThrow("changed");
  await f.service.refresh();
  const edited = first(f.catalog());
  expect(edited).not.toBe(initial);
  await rm(f.file);
  await f.service.refresh();
  expect(f.catalog()).toEqual([]);
  expect(f.service.status().forgePlugins).toHaveLength(1);
  await expect(edited.validate()).rejects.toThrow("changed");
  await writeFile(f.file, source + " ");
  await f.service.refresh();
  await expect(edited.validate()).rejects.toThrow("changed");
});
it("rejects malformed, oversized, wrong-kind/filename and reserved IDs without probes", async () => {
  const f = await fixture();
  for (const content of [
    "bad",
    source.replace('"custom"', '"mismatch"'),
    JSON.stringify(github),
    JSON.stringify(agent),
    source + " ".repeat(65536),
    Buffer.from([255]),
  ]) {
    await writeFile(f.file, content);
    const status = await f.service.refresh();
    expect((await validateConfig(f.root)).code).toBe(1);
    expect(f.catalog()).toEqual([]);
    const rejectedForge = status.forgePlugins?.find((entry) => entry.id === "custom");
    expect(rejectedForge?.file).toBe("forges/custom.json");
    expect(typeof rejectedForge?.reason).toBe("string");
    expect(status.rejected.some(({ file }) => file === "forges/custom.json")).toBe(true);
  }
  await writeFile(join(f.root, "agents", "custom.json"), source);
  expect((await f.service.refresh()).agentPlugins?.[0]?.reason).toContain("invalid-kind");
});
it("enforces each kind's catalog cap and independent ID namespace", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 51 }, (_, index) => {
      const id = `forge-${String(index).padStart(2, "0")}`;
      return writeFile(join(f.root, "forges", `${id}.json`), JSON.stringify({ ...github, id }));
    }),
  );
  await writeFile(join(f.root, "agents", `${agent.id}.json`), JSON.stringify(agent));
  await f.service.refresh();
  expect(f.catalog()).toHaveLength(50);
  expect(f.catalog().some(({ manifest }) => manifest.id === "forge-50")).toBe(false);
  // Adding a sorted-earlier name retires a previously loaded file outside the cap.
  const old = f.catalog().at(-1);
  if (!old) throw new Error("Missing last forge");
  await writeFile(join(f.root, "forges", "aaa.json"), JSON.stringify({ ...github, id: "aaa" }));
  await f.service.refresh();
  expect(f.catalog()).toHaveLength(50);
  await expect(old.validate()).rejects.toThrow("changed");
});
it("rejects linked files/directories and resubscribes when the forge directory is replaced", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.json");
  await writeFile(outside, source);
  await symlink(outside, f.file);
  expect((await f.service.refresh()).rejected).toContainEqual({
    file: "forges/custom.json",
    reason: "$: unsafe-file",
  });
  expect(f.catalog()).toEqual([]);
  await rm(join(f.root, "forges"), { recursive: true });
  const other = join(f.root, "other");
  await mkdir(other);
  await writeFile(join(other, "custom.json"), source);
  await symlink(other, join(f.root, "forges"), process.platform === "win32" ? "junction" : "dir");
  await f.service.refresh();
  expect(f.catalog()).toEqual([]);
  await rm(join(f.root, "forges"));
  await rename(other, join(f.root, "forges"));
  const previous = f.watches.get(join(f.root, "forges"));
  f.watches.get(f.root)?.listener("forges");
  expect(previous?.close).toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(f.catalog()).toHaveLength(1);
  });
  const count = f.applyForges.mock.calls.length;
  const loaded = first(f.catalog());
  await f.service.dispose();
  await expect(loaded.validate()).rejects.toThrow("changed");
  f.watches.get(join(f.root, "forges"))?.listener("custom.json");
  await f.service.refresh();
  expect(f.applyForges).toHaveBeenCalledTimes(count);
});
