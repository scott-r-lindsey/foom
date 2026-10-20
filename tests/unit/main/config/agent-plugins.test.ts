import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import v2Fixture from "../../../fixtures/agent-plugin-v2.json";
import manifest from "../../../fixtures/agent-plugin.json";
import { ConfigService } from "../../../../src/main/config/service";
import { configPart } from "../../../../src/main/config/approval";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import {
  agentProvider,
  agentProviders,
  knownAgentId,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import type { ConfigSettings } from "../../../../src/shared/config";

const roots: string[] = [];
const services: ConfigService[] = [];
afterEach(async () => {
  replaceConfigProviders([]);
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-config-plugins-"));
  roots.push(root);
  const folder = join(root, "config");
  const digests = new Map<string, string>();
  const baseline = {
    get: (file: string) => digests.get(file) ?? null,
    set: (file: string, value: string | null) => {
      if (value === null) digests.delete(file);
      else digests.set(file, value);
      return Promise.resolve();
    },
  };
  const dependencies = {
    root: folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: vi.fn((_values: ConfigSettings) => undefined),
    baseline: { get: () => null, set: () => Promise.resolve() },
    themeBaseline: baseline,
    applyPlugins: replaceConfigProviders,
    watch: () => ({ close: () => undefined }),
  };
  const service = new ConfigService(dependencies);
  services.push(service);
  await service.initialize();
  const file = join(folder, "agents", `${manifest.id}.json`);
  return { root, folder, file, service, dependencies };
}
it("loads a valid manifest as soon as it is read, with nothing held, and again after a restart", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  const status = await f.service.refresh();
  expect(status.pending).toBeNull();
  expect(status.agentPlugins).toEqual([]);
  expect(knownAgentId(manifest.id)).toBe(true);
  await expect(agentProvider(manifest.id).validate?.()).resolves.toBeUndefined();
  await f.service.dispose();
  replaceConfigProviders([]);
  const again = new ConfigService(f.dependencies);
  services.push(again);
  await again.initialize();
  expect(again.status().pending).toBeNull();
  expect(agentProviders().map((provider) => provider.id)).toContain(manifest.id);
  await expect(again.decide("allow", "f".repeat(64))).rejects.toThrow("No change");
});
it("reloads edits, fails launches bound to the old bytes, and withdraws invalid or removed manifests", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  await f.service.refresh();
  const old = agentProvider(manifest.id);
  await writeFile(f.file, JSON.stringify({ ...manifest, name: "Edited" }));
  await expect(old.validate?.()).rejects.toThrow("changed");
  await f.service.refresh();
  const edited = agentProvider(manifest.id);
  expect(edited).not.toBe(old);
  expect(edited.name).toBe("Edited");
  await expect(edited.validate?.()).resolves.toBeUndefined();
  await f.service.refresh();
  expect(agentProvider(manifest.id)).toBe(edited);
  await writeFile(f.file, "{}");
  const invalid = await f.service.refresh();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(invalid.agentPlugins?.[0]).toMatchObject({ id: manifest.id, state: "rejected" });
  expect(invalid.agentPlugins?.[0]?.reason).toContain("missing-key");
  await writeFile(f.file, Buffer.from([255]));
  await f.service.refresh();
  expect(f.service.status().rejected[0]?.reason).toBe("$: invalid-manifest");
  await writeFile(f.file, JSON.stringify(manifest));
  await f.service.refresh();
  expect(knownAgentId(manifest.id)).toBe(true);
  await rm(f.file);
  const removed = await f.service.refresh();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(removed.agentPlugins).toEqual([]);
});
it("rejects mismatched IDs and redirected files without reading outside the folder", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ ...manifest, id: "other-agent" }));
  await f.service.refresh();
  expect(f.service.status().rejected[0]?.reason).toContain("filename-mismatch");
  expect(knownAgentId("other-agent")).toBe(false);
  await rm(f.file);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, JSON.stringify(manifest));
  await symlink(outside, f.file);
  await f.service.refresh();
  expect(f.service.status().rejected[0]?.reason).toContain("unsafe-file");
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(await readFile(outside, "utf8")).toBe(JSON.stringify(manifest));
});
it("a held settings change does not hold plugins", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  const other = { ...manifest, id: "second-agent", name: "Second agent" };
  await writeFile(join(f.folder, "agents", "second-agent.json"), JSON.stringify(other));
  await writeFile(
    join(f.folder, "settings.json"),
    JSON.stringify({ kind: "settings", hooks: false }),
  );
  const status = await f.service.refresh();
  expect(status.pending?.file).toBe("settings.json");
  expect(status.agentPlugins).toEqual([]);
  expect(knownAgentId(other.id)).toBe(true);
  expect(knownAgentId(manifest.id)).toBe(true);
});
it("replaces a provider with an edited v2 manifest under the same ID and keeps it across a restart", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  await f.service.refresh();
  const old = agentProvider(manifest.id);
  const v2 = await import("../../../fixtures/agent-plugins-v2/agy.json");
  await writeFile(f.file, JSON.stringify({ ...v2.default, id: manifest.id }));
  const status = await f.service.refresh();
  expect(status.agentPlugins).toEqual([]);
  expect(agentProvider(manifest.id).model.version).toBe(2);
  await expect(old.validate?.()).rejects.toThrow("changed");
  await f.service.dispose();
  const restarted = new ConfigService(f.dependencies);
  services.push(restarted);
  await restarted.initialize();
  expect(agentProvider(manifest.id).model.version).toBe(2);
  expect(restarted.status().agentPlugins).toEqual([]);
});
it("drops only a newly protected provider default list on load and rejects invalid saves", async () => {
  const f = await fixture();
  const argumentsBefore = {
    claude: ["--model", "safe"],
    codex: [],
    agy: [],
    [v2Fixture.id]: ["--resume=saved"],
    other: ["ordinary"],
  };
  await f.service.write({ agentArguments: argumentsBefore });
  const settingsFile = join(f.folder, "settings.json");
  const settingsBytes = await readFile(settingsFile, "utf8");
  await writeFile(join(f.folder, "agents", `${v2Fixture.id}.json`), JSON.stringify(v2Fixture));
  await f.service.refresh();
  expect(agentProvider(v2Fixture.id).model.version).toBe(2);
  expect(f.dependencies.apply.mock.calls.at(-1)?.[0].agentArguments).toEqual({
    ...argumentsBefore,
    [v2Fixture.id]: [],
  });
  expect(await readFile(settingsFile, "utf8")).toBe(settingsBytes);
  await expect(f.service.write({ agentArguments: argumentsBefore })).rejects.toThrow(
    "cannot be stored",
  );
  expect(await readFile(settingsFile, "utf8")).toBe(settingsBytes);
});

it.each(["claude", "codex", "agy"])(
  "a hand-made copy of the %s build input loads as a config provider without bundled consent",
  async (id) => {
    const { bundledAgentData } = await import("../../../../src/shared/bundled-agent-data");
    const f = await fixture();
    const original = bundledAgentData.find((entry) => entry.id === id);
    if (!original) throw Error("Missing bundled manifest");
    const file = join(f.folder, `agents/${id}-custom.json`);
    const text = JSON.stringify({
      ...original,
      id: `${id}-custom`,
      name: `${original.name} (custom)`,
    });
    await writeFile(file, text);
    const status = await f.service.refresh();
    expect(status.agentPlugins).toEqual([]);
    const provider = agentProvider(`${id}-custom`);
    expect(provider.origin).not.toBe("bundled");
    await writeFile(file, `${text} `);
    await expect(provider.validate?.()).rejects.toThrow("changed");
  },
);

it.each([1, 3, "2", null])(
  "withdraws unsupported agent version %s with a fixed diagnostic",
  async (version) => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify(manifest));
    await f.service.refresh();
    const loaded = agentProvider(manifest.id);
    await writeFile(f.file, JSON.stringify({ ...manifest, version }));
    const status = await f.service.refresh();
    expect(knownAgentId(manifest.id)).toBe(false);
    expect(status.agentPlugins?.[0]).toMatchObject({
      id: manifest.id,
      state: "rejected",
      reason:
        version === 1
          ? "$.version: Agent manifest version 1 is no longer supported; use version 2 (see README.md)"
          : "$.version: Agent manifest version must be 2 (see README.md)",
    });
    await expect(loaded.validate?.()).rejects.toThrow("changed");
  },
);
