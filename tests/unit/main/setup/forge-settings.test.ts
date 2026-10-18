import { expect, test } from "vitest";
import { parseForgeEnablement, parseForgeHosts } from "../../../../src/main/setup/forge-settings";
import {
  parseSettingsPatch,
  DEFAULT_SETTINGS,
  SettingsStore,
} from "../../../../src/main/setup/settings";
import { parseConfigSettings } from "../../../../src/shared/config-settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("forge preferences are copied, bounded, profile-only and default to bundled GitHub", () => {
  expect(DEFAULT_SETTINGS.forges).toEqual({ github: true });
  expect(DEFAULT_SETTINGS.forgeHosts).toEqual({ "github.com": "github" });
  const hosts = { "git.example.org": "custom" };
  expect(parseForgeHosts(hosts)).toEqual(hosts);
  expect(parseForgeHosts(hosts)).not.toBe(hosts);
  expect(parseSettingsPatch({ forgeHosts: hosts, forges: { custom: true } })).toEqual({
    forgeHosts: hosts,
    forges: { custom: true },
  });
  expect(() => parseConfigSettings({ forgeHosts: hosts })).toThrow();
  expect(() => parseConfigSettings({ forges: { custom: true } })).toThrow();
  expect(parseForgeEnablement({ github: false, custom: true })).toEqual({
    github: false,
    custom: true,
  });
  expect(parseForgeHosts({})).toEqual({});
  expect(parseForgeEnablement({ all: true, shell: false })).toEqual({ all: true, shell: false });
});
test.each([null, [], true, "host", 1])("rejects non-record forge settings: %s", (value) => {
  expect(() => parseForgeHosts(value)).toThrow();
  expect(() => parseForgeEnablement(value)).toThrow();
});
test.each([
  "",
  "Git.Example.org",
  "https://git.example.org",
  "git.example.org:443",
  "user@git.example.org",
  "git.example.org/",
  "git..org",
  "git.example.org.",
  "*.example.org",
  "-git.example.org",
  "git-.example.org",
  "127.0.0.1",
  "127.1",
  "2130706433",
  "0x7f000001",
  "0x7f.0.0.1",
  "git.999999999999",
  "[::1]",
  "host%2eexample.org",
  "a".repeat(64) + ".org",
  "a.".repeat(127) + "org",
  "constructor",
  "prototype",
  "__proto__",
  "git\n.org",
])("refuses unsafe hostname %s", (host) => {
  expect(() => parseForgeHosts({ [host]: "github" })).toThrow();
});
test.each([null, true, "", "constructor", "UPPER", "../github", "x".repeat(41)])(
  "refuses invalid target %s",
  (id) => {
    expect(() => parseForgeHosts({ "git.example.org": id })).toThrow();
  },
);
test("rejects unsafe IDs, nonboolean enablement and excessive maps", () => {
  for (const value of [{ custom: 1 }, { "../custom": true }, JSON.parse('{"__proto__":true}')])
    expect(() => parseForgeEnablement(value)).toThrow();
  expect(() =>
    parseForgeEnablement(
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`forge-${String(i)}`, true])),
    ),
  ).toThrow();
  expect(() =>
    parseForgeHosts(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`host-${String(i)}.org`, "github"]),
      ),
    ),
  ).toThrow();
});
test("persists forge preferences through config attachment and restart, with write failure rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-forge-settings-"));
  try {
    const store = await SettingsStore.open(root);
    await store.attachConfig(async () => {}, {}, null);
    const patch = {
      forges: { github: false, custom: true },
      forgeHosts: { "git.example.org": "custom" },
    };
    await store.update(parseSettingsPatch(patch));
    const reopened = await SettingsStore.open(root);
    expect(reopened.get()).toMatchObject(patch);
    await rm(root, { recursive: true });
    // A parent that is a file makes the atomic write fail.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(root, "blocked");
    await expect(reopened.update({ forges: {} })).rejects.toThrow();
    expect(reopened.get()).toMatchObject(patch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
