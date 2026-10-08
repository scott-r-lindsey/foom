import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgyPlugin, agyPluginDirectory } from "../../../../src/main/agents/agy-plugin";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "foom-agy-status-"));
  directories.push(home);
  const config = join(home, ".gemini/config");
  const directory = join(config, "plugins/foom");
  await mkdir(config, { recursive: true });
  const run = vi.fn((_executable: string, _args: readonly string[], _options: unknown) =>
    Promise.resolve({
      stdout: "No imported plugins.\n",
    }),
  );
  const plugin = new AgyPlugin(home, run);
  const manifest = async (value: unknown) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plugin.json"), JSON.stringify(value));
  };
  const settings = (value: unknown) =>
    writeFile(join(config, "config.json"), JSON.stringify(value));
  return { home, directory, config, run, plugin, manifest, settings };
}

test("detects absence, installed versions, updates and user-disabled preference", async () => {
  const { plugin, run, manifest, settings } = await fixture();
  expect(await plugin.status("/resolved/agy")).toEqual({ state: "not-installed" });
  expect(run).toHaveBeenCalledWith(
    "/resolved/agy",
    ["plugin", "list"],
    expect.objectContaining({ timeout: 5000, maxBuffer: 65536 }),
  );
  run.mockResolvedValue({ stdout: '{"imports":[{"name":"foom","components":["hooks"]}]}' });
  expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  await manifest({ name: "foom", foomObserverVersion: 0 });
  expect(await plugin.status("agy")).toEqual({ state: "outdated", version: 0 });
  await manifest({ name: "foom", foomObserverVersion: 1, disabled: true });
  expect(await plugin.status("agy")).toEqual({ state: "disabled", version: 1 });
  await settings({ plugins: { foom: { enabled: true }, unrelated: { enabled: false } } });
  expect(await plugin.status("agy")).toEqual({ state: "installed", version: 1 });
  await settings({ plugins: { foom: { enabled: false } } });
  expect(await plugin.status("agy")).toEqual({ state: "disabled", version: 1 });
});

test("refuses malformed, conflicting, oversized, or unreadable metadata and failed CLI probes", async () => {
  const { plugin, run, manifest, settings, directory } = await fixture();
  for (const value of [
    null,
    [],
    { name: "other", foomObserverVersion: 1 },
    { name: "foom", foomObserverVersion: "1" },
    { name: "foom", foomObserverVersion: -1 },
    { name: "foom", foomObserverVersion: 1.5 },
  ]) {
    await manifest(value);
    expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  }
  await manifest({ name: "foom", foomObserverVersion: 1 });
  for (const value of [
    [],
    { plugins: [] },
    { plugins: { foom: {} } },
    { plugins: { foom: { enabled: 1 } } },
  ]) {
    await settings(value);
    expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  }
  await settings({});
  await writeFile(join(directory, "plugin.json"), " ".repeat(65537));
  expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  await writeFile(join(directory, "plugin.json"), "{");
  expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  for (const stdout of ["not json", "{}", '{"imports":{}}']) {
    run.mockResolvedValue({ stdout });
    expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
  }
  run.mockRejectedValue(new Error("private output"));
  expect(await plugin.status("agy")).toEqual({ state: "unavailable" });
});

test("mutations use fixed argument arrays, recheck status, serialize and redact CLI failures", async () => {
  const { plugin, run, manifest } = await fixture();
  await expect(plugin.change("agy", "remove")).rejects.toThrow("changed");
  await plugin.change("agy", "install");
  expect(run).toHaveBeenLastCalledWith(
    "agy",
    ["plugin", "install", agyPluginDirectory()],
    expect.any(Object),
  );
  await manifest({ name: "foom", foomObserverVersion: 0 });
  await expect(plugin.change("agy", "install")).rejects.toThrow("changed");
  for (const [action, args] of [
    ["update", ["plugin", "install", agyPluginDirectory()]],
    ["enable", ["plugin", "enable", "foom"]],
    ["remove", ["plugin", "uninstall", "foom"]],
  ] as const) {
    await plugin.change("agy", action);
    expect(run).toHaveBeenLastCalledWith("agy", args, expect.any(Object));
  }
  run
    .mockResolvedValueOnce({ stdout: "No imported plugins." })
    .mockRejectedValueOnce(new Error("secret CLI text"));
  await expect(plugin.change("agy", "remove")).rejects.toThrow("Antigravity plugin command failed");
  let release: ((value: { stdout: string }) => void) | undefined;
  run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = plugin.change("agy", "remove");
  await expect(plugin.change("agy", "remove")).rejects.toThrow("busy");
  release?.({ stdout: "No imported plugins." });
  await first;
  await manifest({ name: "somebody else's plugin" });
  await expect(plugin.change("agy", "remove")).rejects.toThrow("changed");
});
