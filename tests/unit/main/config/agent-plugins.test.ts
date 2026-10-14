import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import manifest from "../../../fixtures/agent-plugin.json";
import { ConfigService } from "../../../../src/main/config/service";
import { ConfigGit, prepareIsolation } from "../../../../src/main/config/git";
import { configPart } from "../../../../src/main/config/approval";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import {
  agentProvider,
  agentProviders,
  knownAgentId,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import type { DialogContent } from "../../../../src/shared/confirmation";
import { digest } from "../../../../src/main/config/layout";

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
  const git = new ConfigGit(folder, await prepareIsolation(join(root, "isolation")));
  const digests = new Map<string, string>();
  const confirm = vi.fn((_content: DialogContent) => Promise.resolve(false));
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
    git,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => undefined,
    baseline: { get: () => null, set: () => Promise.resolve() },
    themeBaseline: baseline,
    pluginBaseline: baseline,
    confirmPlugin: confirm,
    applyPlugins: replaceConfigProviders,
    watch: () => ({ close: () => undefined }),
  };
  const service = new ConfigService(dependencies);
  services.push(service);
  await service.initialize();
  const file = join(folder, "agents", `${manifest.id}.json`);
  return { root, folder, file, service, confirm, digests, dependencies };
}
async function pending(service: ConfigService): Promise<string> {
  const status = await service.refresh();
  expect(status.pending?.file).toBe(`agents/${manifest.id}.json`);
  if (!status.pending) throw Error("No pending plugin");
  return status.pending.id;
}
it("holds new manifests without discovery, requires trusted approval, and persists only the approved digest", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  const id = await pending(f.service);
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(() => agentProvider(manifest.id)).toThrow("Unknown agent");
  expect((await f.service.decide("allow", id)).pending?.id).toBe(id);
  expect(f.confirm).toHaveBeenCalledOnce();
  const content = f.confirm.mock.calls[0]?.[0];
  expect(content?.sections?.map((section) => section.label)).toEqual(
    expect.arrayContaining([
      "Executable names (resolved on PATH)",
      "Launch arguments",
      "Launch prompt",
      "Launch resume",
      "Launch hooks",
      "Launch mcp",
      "Launch allowedTools",
      "Bypass arguments",
      "Hook mapping",
    ]),
  );
  expect(f.digests.size).toBe(0);
  f.confirm.mockResolvedValue(true);
  expect((await f.service.decide("allow", id)).pending).toBeNull();
  expect(knownAgentId(manifest.id)).toBe(true);
  await expect(agentProvider(manifest.id).validate?.()).resolves.toBeUndefined();
  expect(f.digests.get(`agents/${manifest.id}.json`)).toBe(digest(JSON.stringify(manifest)));
  const again = new ConfigService(f.dependencies);
  services.push(again);
  await again.initialize();
  expect(again.status().pending).toBeNull();
  expect(agentProviders().map((provider) => provider.id)).toContain(manifest.id);
  await expect(again.decide("allow", id)).rejects.toThrow("No change");
});
it("requires re-approval on edits and rechecks exact bytes after a dialog; old launch capabilities fail immediately", async () => {
  const f = await fixture();
  const original = JSON.stringify(manifest);
  await writeFile(f.file, original);
  f.confirm.mockResolvedValue(true);
  await f.service.decide("allow", await pending(f.service));
  const old = agentProvider(manifest.id);
  await writeFile(f.file, JSON.stringify({ ...manifest, name: "Edited" }));
  await expect(old.validate?.()).rejects.toThrow("changed");
  const id = await pending(f.service);
  expect(knownAgentId(manifest.id)).toBe(false);
  await expect(f.service.decide("allow", "0".repeat(64))).rejects.toThrow("replaced");
  f.confirm.mockImplementation(async () => {
    await writeFile(f.file, JSON.stringify({ ...manifest, name: "Replaced during approval" }));
    return true;
  });
  await expect(f.service.decide("allow", id)).rejects.toThrow("file changed");
  expect(knownAgentId(manifest.id)).toBe(false);
  const current = await pending(f.service);
  await f.service.decide("keep", current);
  expect(await readFile(f.file, "utf8")).toBe(original);
  expect(knownAgentId(manifest.id)).toBe(true);
  await writeFile(f.file, "{}");
  await f.service.refresh();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(f.service.status().changes[0]?.reason).toContain("missing-key");
});
it("declines new plugins by removing only their contained file and rejects mismatched IDs and redirected files", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  await f.service.decide("keep", await pending(f.service));
  await expect(readFile(f.file)).rejects.toThrow();
  expect(f.confirm).not.toHaveBeenCalled();
  await writeFile(f.file, JSON.stringify({ ...manifest, id: "other-agent" }));
  await f.service.refresh();
  expect(f.service.status().changes[0]?.reason).toContain("filename-mismatch");
  await writeFile(f.file, JSON.stringify(manifest));
  const id = await pending(f.service);
  await rm(f.file);
  await expect(f.service.decide("allow", id)).rejects.toThrow("file changed");
  const outside = join(f.root, "outside.json");
  await writeFile(outside, JSON.stringify(manifest));
  await symlink(outside, f.file);
  await f.service.refresh();
  expect(f.service.status().changes[0]?.reason).toContain("unsafe-file");
  expect(await readFile(outside, "utf8")).toBe(JSON.stringify(manifest));
});
it("does not trust a config git commit, revokes deletions and invalid edits, and refuses failed consent persistence", async () => {
  const f = await fixture();
  const text = JSON.stringify(manifest);
  await writeFile(f.file, text);
  await f.dependencies.git.commit(
    new Map([[`agents/${manifest.id}.json`, Buffer.from(text)]]),
    "Untrusted manifest commit",
  );
  expect(await pending(f.service)).toBeTruthy();
  expect(knownAgentId(manifest.id)).toBe(false);
  f.confirm.mockResolvedValue(true);
  await f.service.decide("allow", await pending(f.service));
  await rm(f.file);
  await f.service.refresh();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(f.digests.size).toBe(0);
  await writeFile(f.file, Buffer.from([255]));
  await f.service.refresh();
  expect(f.service.status().changes[0]?.reason).toBe("$: invalid-manifest");
  await writeFile(f.file, text);
  const id = await pending(f.service);
  f.dependencies.pluginBaseline.set = () => Promise.reject(Error("write failed"));
  await expect(f.service.decide("allow", id)).rejects.toThrow("write failed");
  expect(knownAgentId(manifest.id)).toBe(false);
});
