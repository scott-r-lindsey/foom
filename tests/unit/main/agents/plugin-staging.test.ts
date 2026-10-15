import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { pluginContent, stagePlugin } from "../../../../src/main/agents/plugin-staging";
import { observerAssets } from "../../../../src/main/agents/providers/v2-observers";
import fixture from "../../../fixtures/agent-plugins-v2/agy.json";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function model() {
  return parseAgentManifest(JSON.stringify({ ...fixture, id: "staged-fixture" })).model;
}
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "foom-staging-"));
  roots.push(directory);
  return directory;
}
it.each([false, true])(
  "stages deterministic generated observer bytes and relative commands (windows=%s)",
  async (windows) => {
    const m = model();
    const channel = m.hooks?.channels[0];
    if (!channel) throw Error("Missing fixture channel");
    const first = await stagePlugin(m, await root(), { hooksEnabled: false }, windows);
    const second = await stagePlugin(m, await root(), { hooksEnabled: true }, windows);
    expect(first.files).toEqual(second.files);
    for (const [name, content] of Object.entries(observerAssets(channel, windows)))
      expect(await readFile(join(first.directory, "observers/lifecycle", name), "utf8")).toBe(
        content,
      );
    const hooks = await readFile(join(first.directory, "hooks.json"), "utf8");
    expect(hooks).toContain("./observers/lifecycle/observer.");
    expect(hooks).toContain("PreInvocation");
    expect(hooks).not.toMatch(/foom-v2-hooks-|127\.0\.0\.1|FOOM_TOKEN/u);
    await first.verify();
    expect((await stagePlugin(m, roots[0] ?? "", {}, windows)).directory).toBe(first.directory);
    const original = pluginContent(m, {}, windows);
    channel.observer.timeoutMs = 2000;
    expect(pluginContent(m, {}, windows).fingerprint).not.toBe(original.fingerprint);
    channel.observer.version = 3;
    expect(pluginContent(m, {}, windows).content).not.toEqual(original.content);
  },
);
it.each(["extra", "changed", "missing", "link", "directory-link", "many-extra"])(
  "refuses %s staging tampering before reuse",
  async (failure) => {
    const m = model();
    const home = await root();
    const staged = await stagePlugin(m, home, {});
    const script = join(
      staged.directory,
      "observers/lifecycle",
      process.platform === "win32" ? "observer.ps1" : "observer.sh",
    );
    if (failure === "extra") await writeFile(join(staged.directory, "extra.json"), "{}");
    if (failure === "many-extra")
      for (let index = 0; index < 12; index++)
        await writeFile(join(staged.directory, `extra${String(index)}`), "{}");
    if (failure === "changed") await writeFile(script, "changed");
    if (failure === "missing") await rm(script);
    if (failure === "link") {
      const outside = join(home, "outside");
      await writeFile(outside, "changed");
      await rm(script);
      await symlink(outside, script);
    }
    if (failure === "directory-link") {
      const folder = join(staged.directory, "observers/lifecycle");
      await rm(folder, { recursive: true });
      await symlink(home, folder, "junction");
    }
    await expect(staged.verify()).rejects.toThrow();
    if (failure !== "missing") await expect(stagePlugin(m, home, {})).rejects.toThrow();
  },
);
it("keeps unreferenced channels out of staging and rejects generated path collisions", () => {
  const m = model();
  const channel = m.hooks?.channels[0];
  if (!channel) throw Error("Missing fixture channel");
  m.hooks?.channels.push({ ...channel, id: "unused" });
  expect(pluginContent(m, {}).content.some((file) => file.name.includes("unused"))).toBe(false);
  for (const name of ["observers/lifecycle/observer.sh", "observers/lifecycle", "observers"]) {
    const changed = structuredClone(m);
    changed.files.push({ name, scope: "plugin", format: "json", content: "{}", when: undefined });
    expect(() => pluginContent(changed, {}, false)).toThrow("Conflicting");
  }
  channel.observer.placement = "launch";
  expect(() => pluginContent(m, {})).toThrow("placement");
});
