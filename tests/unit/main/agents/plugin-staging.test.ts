import { afterEach, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import {
  installedPluginCurrent,
  pluginContent,
  pluginPathMatches,
  validateInstalledPluginPath,
  stagePlugin,
} from "../../../../src/main/agents/plugin-staging";
import {
  observerAssets,
  observerInvocation,
} from "../../../../src/main/agents/providers/v2-observers";
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
  "stages deterministic generated observer bytes and anchored commands (windows=%s)",
  async (windows) => {
    const m = model();
    const channel = m.hooks?.channels[0];
    if (!channel) throw Error("Missing fixture channel");
    const firstHome = await root();
    const first = await stagePlugin(m, firstHome, { hooksEnabled: false }, windows, firstHome);
    const secondHome = await root();
    const second = await stagePlugin(m, secondHome, { hooksEnabled: true }, windows, secondHome);
    expect(first.directory.split(/[\\/]/u).at(-1)).toBe(second.directory.split(/[\\/]/u).at(-1));
    for (const [name, content] of Object.entries(observerAssets(channel, windows)))
      expect(await readFile(join(first.directory, "observers/lifecycle", name), "utf8")).toBe(
        content,
      );
    const hooks = await readFile(join(first.directory, "hooks.json"), "utf8");
    expect(hooks).not.toContain("./observers/lifecycle/observer.");
    const installed = join(await realpath(firstHome), ".gemini/config/plugins/foom");
    const script = `${installed}/observers/lifecycle/observer.${windows ? "ps1" : "sh"}`;
    expect(hooks).toContain(
      JSON.stringify(observerInvocation(script, ["PreInvocation"], windows, false).command),
    );
    expect(hooks).not.toMatch(/foom-v2-hooks-|127\.0\.0\.1|FOOM_TOKEN/u);
    await first.verify();
    expect((await stagePlugin(m, firstHome, {}, windows, firstHome)).directory).toBe(
      first.directory,
    );
    const original = pluginContent(m, {}, windows);
    channel.observer.timeoutMs = 2000;
    expect(pluginContent(m, {}, windows).fingerprint).not.toBe(original.fingerprint);
    channel.observer.version = 3;
    expect(pluginContent(m, {}, windows).content).not.toEqual(original.content);
  },
);
it.skipIf(process.platform === "win32")(
  "runs the staged observer from a foreign cwd with planted scripts and shell characters in its path",
  async () => {
    const directory = await root();
    const profile = join(directory, "profile with ' quotes $dollar `ticks`");
    const cwd = join(directory, "repository");
    await mkdir(profile);
    await mkdir(join(cwd, "observers/lifecycle"), { recursive: true });
    for (const name of ["observer.sh", "observers/lifecycle/observer.sh"])
      await writeFile(join(cwd, name), "printf POISONED");
    const staged = await stagePlugin(model(), profile, {}, false, profile);
    const installed = join(profile, ".gemini/config/plugins/foom");
    await cp(staged.directory, installed, { recursive: true });
    const script = join(installed, "observers/lifecycle/observer.sh");
    const command = observerInvocation(script, ["PreInvocation"], false, false).command;
    const { stdout, stderr } = await promisify(execFile)("/bin/sh", ["-c", command], {
      cwd,
      env: {},
      timeout: 5000,
    });
    expect(stdout.trim()).toBe("{}");
    expect(stderr).toBe("");
  },
);
it.each(["extra", "changed", "missing", "link", "directory-link", "many-extra"])(
  "refuses %s staging tampering before reuse",
  async (failure) => {
    const m = model();
    const home = await root();
    const staged = await stagePlugin(m, home, {}, process.platform === "win32", home);
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
    if (failure !== "missing")
      await expect(stagePlugin(m, home, {}, process.platform === "win32", home)).rejects.toThrow();
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

it("refuses an installed inventory check without fixed ownership", async () => {
  const m = model();
  m.setup = undefined;
  expect(await installedPluginCurrent(m, {}, await root())).toBe(false);
});

it.each(["linux", "darwin", "win32"] as const)(
  "checks exact reported spellings on %s",
  (platform) => {
    const expected =
      platform === "win32"
        ? "C:\\Users\\Fixture\\.gemini\\config\\plugins\\foom"
        : "/Users/Fixture/.gemini/config/plugins/foom";
    const separator = platform === "win32" ? "\\" : "/";
    expect(pluginPathMatches(expected, expected, platform)).toBe(true);
    expect(pluginPathMatches(expected.toUpperCase(), expected, platform)).toBe(
      platform !== "linux",
    );
    for (const suffix of [separator, `${separator}.`, `${separator}..${separator}foom`])
      expect(pluginPathMatches(expected + suffix, expected, platform)).toBe(false);
    for (const segment of [".", "..", ""])
      expect(
        pluginPathMatches(
          expected.replace(`${separator}.gemini`, `${separator}${segment}${separator}.gemini`),
          expected,
          platform,
        ),
      ).toBe(false);
    for (const value of [undefined, {}, "/".repeat(4097), `${expected}\n`])
      expect(pluginPathMatches(value, expected, platform)).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a symlink-plus-parent path even when lexical normalization matches ownership",
  async () => {
    const home = await root();
    const foreign = await root();
    const relative = ".gemini/config/plugins/foom";
    await mkdir(join(home, relative), { recursive: true });
    await mkdir(join(foreign, "child"));
    await mkdir(join(foreign, relative), { recursive: true });
    await symlink(
      join(foreign, "child"),
      join(home, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const reported = `${home}/redirect/../${relative}`;
    expect(await realpath(reported)).toBe(await realpath(join(foreign, relative)));
    await expect(validateInstalledPluginPath(model(), home, reported)).rejects.toThrow(
      "install path",
    );
    await expect(
      validateInstalledPluginPath(model(), home, join(home, relative)),
    ).resolves.toBeUndefined();
  },
);

it("confirms a canonical home alias by filesystem identity", async () => {
  const parent = await root();
  const home = join(parent, "home");
  const alias = join(parent, "alias");
  await mkdir(join(home, ".gemini/config/plugins/foom"), { recursive: true });
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(
    validateInstalledPluginPath(model(), alias, join(alias, ".gemini/config/plugins/foom")),
  ).resolves.toBeUndefined();
});

it.skipIf(process.platform === "win32" || process.platform === "darwin")(
  "rejects case variants with different realpath identities on a case-sensitive filesystem",
  async () => {
    const parent = await root();
    const home = join(parent, "Home");
    const foreign = join(parent, "home");
    const relative = ".gemini/config/plugins/foom";
    await mkdir(join(home, relative), { recursive: true });
    await mkdir(join(foreign, relative), { recursive: true });
    await expect(
      validateInstalledPluginPath(model(), home, join(foreign, relative), "darwin"),
    ).rejects.toThrow("install path");
    await expect(
      validateInstalledPluginPath(model(), home, join(foreign, relative), "win32"),
    ).rejects.toThrow("install path");
  },
);

it("checks native mixed-case spellings against the actual filesystem identity", async () => {
  const parent = await root();
  const home = join(parent, "MixedHome");
  const relative = ".gemini/config/plugins/foom";
  await mkdir(join(home, relative), { recursive: true });
  const reported = join(parent, "mixedhome", relative);
  const exists = await realpath(reported).then(
    () => true,
    () => false,
  );
  const result = validateInstalledPluginPath(model(), home, reported);
  if (process.platform !== "linux" && exists) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow();
});
