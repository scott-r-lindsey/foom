import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import v2Fixture from "../../../fixtures/agent-plugin-v2.json";
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
import type { ConfigSettings } from "../../../../src/shared/config";
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
    apply: vi.fn((_values: ConfigSettings) => undefined),
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

it("exposes pending/rejected plugin cards and reviews the selected digest when another change is held", async () => {
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
  expect(status.agentPlugins).toHaveLength(2);
  const selected = status.agentPlugins?.find((plugin) => plugin.id === other.id);
  expect(selected).toMatchObject({
    name: "Second agent",
    state: "pending",
    file: "agents/second-agent.json",
  });
  f.confirm.mockResolvedValue(true);
  const next = await f.service.decide("allow", selected?.decisionId);
  expect(next.pending?.file).toBe("settings.json");
  expect(knownAgentId(other.id)).toBe(true);
  expect(knownAgentId(manifest.id)).toBe(false);
  await writeFile(f.file, "{}");
  const rejected = await f.service.refresh();
  expect(rejected.agentPlugins?.[0]).toMatchObject({ id: manifest.id, state: "rejected" });
  expect(rejected.agentPlugins?.[0]?.reason).toContain("missing-key");
});

it("withdraws v1 authority and refuses v2 observer staging before approval even with an approved byte digest", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify(manifest));
  f.confirm.mockResolvedValue(true);
  await f.service.decide("allow", await pending(f.service));
  const old = agentProvider(manifest.id);
  const v2 = await import("../../../fixtures/agent-plugins-v2/agy.json");
  const text = JSON.stringify({ ...v2.default, id: manifest.id });
  await writeFile(f.file, text);
  f.digests.set(`agents/${manifest.id}.json`, digest(text));
  f.confirm.mockClear();
  const status = await f.service.refresh();
  expect(status.agentPlugins).toContainEqual(
    expect.objectContaining({
      id: manifest.id,
      state: "rejected",
      reason: "$.files: v2-observer-staging-unavailable",
    }),
  );
  expect(status.pending).toBeNull();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(f.confirm).not.toHaveBeenCalled();
  await expect(old.validate?.()).rejects.toThrow("changed");
  await f.service.dispose();
  const restarted = new ConfigService(f.dependencies);
  services.push(restarted);
  await restarted.initialize();
  expect(knownAgentId(manifest.id)).toBe(false);
  expect(restarted.status().agentPlugins?.[0]?.reason).toBe(
    "$.files: v2-observer-staging-unavailable",
  );
});

it("approves exact v2 bytes with complete before/after disclosure and withdraws authority during a changed-byte race", async () => {
  const f = await fixture();
  const file = join(f.folder, "agents", `${v2Fixture.id}.json`);
  const original = JSON.stringify(v2Fixture, null, 2) + "\n";
  await writeFile(file, original);
  const status = await f.service.refresh();
  const id = status.agentPlugins?.find((plugin) => plugin.id === v2Fixture.id)?.decisionId;
  expect(knownAgentId(v2Fixture.id)).toBe(false);
  f.confirm.mockResolvedValue(true);
  await f.service.decide("allow", id);
  const old = agentProvider(v2Fixture.id);
  expect(old.model?.version).toBe(2);
  expect(f.digests.get(`agents/${v2Fixture.id}.json`)).toBe(digest(Buffer.from(original)));
  expect(JSON.stringify(f.confirm.mock.calls.at(-1)?.[0])).toContain(digest(original));
  await writeFile(file, original + " ");
  await expect(old.validate?.()).rejects.toThrow("changed");
  const edit = await f.service.refresh();
  const next = edit.agentPlugins?.find((plugin) => plugin.id === v2Fixture.id)?.decisionId;
  f.confirm.mockImplementation(async (content) => {
    expect(
      content.sections?.find(
        (section) => section.label === "Previous approved bytes (JSON-escaped)",
      )?.items,
    ).toEqual([JSON.stringify(original)]);
    await writeFile(file, original + "  ");
    return true;
  });
  await expect(f.service.decide("allow", next)).rejects.toThrow("file changed");
  expect(knownAgentId(v2Fixture.id)).toBe(false);
  expect(f.digests.get(`agents/${v2Fixture.id}.json`)).toBe(digest(original));
});

it("drops only a newly protected provider default list on approval and rejects invalid saves", async () => {
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
  const pending = await f.service.refresh();
  f.confirm.mockResolvedValue(true);
  await f.service.decide(
    "allow",
    pending.agentPlugins?.find((plugin) => plugin.id === v2Fixture.id)?.decisionId,
  );
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
