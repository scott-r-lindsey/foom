import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SettingsStore } from "../../../../src/main/setup/settings";
import { ConfigFiles } from "../../../../src/main/config/files";
import { digest } from "../../../../src/main/config/layout";
import { fixture, palette, theme } from "./service-fixture";

for (const version of ["missing", "corrupt", 1, 2] as const) {
  test(`a ${String(version)} profile adopts existing bytes through ordinary approval`, async () => {
    const f = await fixture();
    const profile = join(f.root, "profile");
    await mkdir(profile);
    if (version !== "missing")
      await writeFile(
        join(profile, "settings.json"),
        version === "corrupt"
          ? "{"
          : JSON.stringify({
              version,
              settings: {
                interfaceTheme: "eclipse-light",
                interfaceScale: 110,
                agentArguments: { claude: ["--verbose"], codex: [], agy: [] },
              },
            }),
      );
    const store = await SettingsStore.open(profile);
    await mkdir(f.folder);
    const text =
      '{ "kind": "settings", "interfaceTheme": "eclipse-dark", "terminalFontSize": 19 }\n';
    await f.write("settings.json", text);
    const values = await f.service.initialize(store.legacyConfig());
    await store.attachConfig((patch) => f.service.write(patch), values, f.baseline());
    expect(await f.read("settings.json")).toBe(text);
    expect(store.get()).toMatchObject({
      interfaceTheme: "eclipse-dark",
      terminalFontSize: 19,
      interfaceScale: 100,
    });
    expect(f.baseline()).toBe(digest(text));
    expect(f.service.status().pending).toBeNull();
    expect(JSON.parse(await readFile(join(profile, "settings.json"), "utf8"))).toMatchObject({
      version: 2,
    });
  });
}

test("adoption holds off switches and arguments without rewriting or approving the file", async () => {
  const f = await fixture();
  await mkdir(f.folder);
  const text = JSON.stringify({
    kind: "settings",
    hooks: false,
    agentArguments: { claude: [], codex: ["--model", "proposal"], agy: [] },
  });
  await f.write("settings.json", text);
  expect(
    await f.service.initialize({
      interfaceTheme: "eclipse-light",
      agentArguments: { claude: ["--verbose"], codex: [], agy: [] },
    }),
  ).toEqual({});
  expect(f.service.status().pending?.detail).toBe("hooks: on → off, agentArguments.codex");
  expect(await f.read("settings.json")).toBe(text);
  expect(f.baseline()).toBeNull();
  await f.decide("keep");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
});

test("adoption holds attention-conflicting theme selection", async () => {
  const f = await fixture();
  await mkdir(join(f.folder, "themes"), { recursive: true });
  const text = JSON.stringify({ kind: "settings", interfaceTheme: "user:warned.json" });
  await f.write("settings.json", text);
  await f.write(
    "themes/warned.json",
    theme("Warned", { ...palette.colors, attention: palette.colors.ink }),
  );
  expect(await f.service.initialize()).toEqual({});
  expect(f.service.status().pending?.detail).toBe("interfaceTheme: attention-distinctness");
  expect(await f.read("settings.json")).toBe(text);
  expect(f.baseline()).toBeNull();
});

test("another profile creating settings during initialization wins byte for byte", async () => {
  const f = await fixture();
  const text = '{ "kind": "settings", "interfaceTheme": "eclipse-dark" }\n';
  const files = new ConfigFiles({ root: f.folder });
  const create = files.createFile.bind(files);
  const publish = vi
    .spyOn(ConfigFiles.prototype, "createFile")
    .mockImplementationOnce(async (relative, content) => {
      await f.write("settings.json", text);
      return create(relative, content);
    });
  try {
    expect(await f.service.initialize({ interfaceTheme: "eclipse-light" })).toEqual({
      interfaceTheme: "eclipse-dark",
    });
    expect(await f.read("settings.json")).toBe(text);
  } finally {
    publish.mockRestore();
  }
});

test("failed initial publication cleans its private temporary file", async () => {
  const f = await fixture();
  await mkdir(f.folder);
  const files = new ConfigFiles({ root: f.folder });
  await expect(files.createFile("missing/settings.json", "{}")).rejects.toThrow();
  await expect(files.createFile("x".repeat(300), "{}")).rejects.toThrow();
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(f.folder)).toEqual([]);
});

test("argument migration never rewrites a replacement captured while reading the approved baseline", async () => {
  const original = '{ "kind": "settings", "terminalFontSize": 19 }\n';
  const proposal = '{ "kind": "settings", "interfaceTheme": "eclipse-dark", "hooks": false }\n';
  const agentArguments = { claude: [], codex: ["--model", "approved"], agy: [] };
  const f = await fixture({ baseline: digest(original), appliedText: original });
  await mkdir(f.folder);
  await f.write("settings.json", original);
  const { rename } = await import("node:fs/promises");
  const files = new ConfigFiles({ root: f.folder });
  const read = files.read.bind(files);
  let settingsReads = 0;
  const reader = vi.spyOn(ConfigFiles.prototype, "read").mockImplementation(async (relative) => {
    const bytes = await read(relative);
    if (relative === "settings.json" && ++settingsReads === 2) {
      await f.write("replacement.tmp", proposal);
      await rename(join(f.folder, "replacement.tmp"), join(f.folder, "settings.json"));
    }
    return bytes;
  });
  try {
    expect(await f.service.initialize({ agentArguments })).toEqual({
      terminalFontSize: 19,
      agentArguments,
    });
    expect(await f.read("settings.json")).toBe(proposal);
    expect(f.service.status().pending).toMatchObject({
      id: digest(proposal),
      detail: "hooks: on → off, agentArguments.codex",
    });
    expect(JSON.parse(f.copy() ?? "null")).toMatchObject({ agentArguments });
  } finally {
    reader.mockRestore();
  }
});
