import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ConfigFiles } from "../../../../src/main/config/files";
import { ApplicationError } from "../../../../src/shared/application-errors";
import { configPart } from "../../../../src/main/config/approval";
import { SettingsStore } from "../../../../src/main/setup/settings";
import { ConfigService } from "../../../../src/main/config/service";
import { digest } from "../../../../src/main/config/layout";
import {
  ThemeBitmaps,
  ThemeLibrary,
  themeBitmapResponse,
} from "../../../../src/main/themes/library";
import { parseThemeFile } from "../../../../src/shared/theme-files";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { fixture, palette, theme, restart, services } from "./service-fixture";

test("themes are checked on add, update and removal; invalid themes are rejected", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/deep.json", theme("Deep"));
  let status = await f.service.refresh();
  expect(status.rejected).toEqual([]);
  await f.write("themes/deep.json", theme("Deep", { ...palette.colors, accent: "red" }));
  status = await f.service.refresh();
  expect(status.rejected).toEqual([
    { file: "themes/deep.json", reason: "$.colors.accent: not-a-color" },
  ]);
  await f.write(
    "terminal-themes/t.json",
    JSON.stringify({
      kind: "terminal-theme",
      name: "Term",
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffffff",
      ansi: Array.from({ length: 16 }, () => "#808080"),
    }),
  );
  expect((await f.service.refresh()).rejected).toHaveLength(1);
  await rm(path.join(f.folder, "themes/deep.json"));
  status = await f.service.refresh();
  expect(status.rejected).toEqual([]);
  await mkdir(path.join(f.folder, "themes/dir.json"));
  expect((await f.service.refresh()).rejected).toEqual([
    { file: "themes/dir.json", reason: "$: unsafe-file" },
  ]);
});

test.skipIf(process.platform === "win32")("linked theme files are refused", async () => {
  const f = await fixture();
  await f.service.initialize();
  await writeFile(path.join(f.root, "outside.json"), theme("Outside"));
  await symlink(path.join(f.root, "outside.json"), path.join(f.folder, "themes/link.json"));
  expect((await f.service.refresh()).rejected).toEqual([
    { file: "themes/link.json", reason: "$: unsafe-file" },
  ]);
});

test("active theme edits are held before display, Keep restores and Allow accepts the exact proposal", async () => {
  const f = await fixture();
  await f.service.initialize();
  const original = theme("Personal");
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.selectTheme("personal.json");
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  expect(f.service.status().pending).toMatchObject({
    file: "themes/personal.json",
    detail: "attention-distinctness",
  });
  const { parseThemeFile } = await import("../../../../src/shared/theme-files");
  expect(
    (
      await f.service.reviewTheme(
        "themes/personal.json",
        proposed,
        parseThemeFile(proposed, "theme"),
      )
    )?.parsed,
  ).toEqual(parseThemeFile(original, "theme"));
  await expect(f.service.decide("allow", "old")).rejects.toThrow("replaced");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.service.status().pending).toBeNull();
  expect(
    (
      await f.service.reviewTheme(
        "themes/personal.json",
        proposed,
        parseThemeFile(proposed, "theme"),
      )
    )?.parsed,
  ).toEqual(parseThemeFile(proposed, "theme"));
});

test("a delayed library review cannot clear a newer held theme edit", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.service.refresh();
  await f.selectTheme("personal.json");
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write(file, proposed);
  await f.service.refresh();
  const pending = f.service.status().pending;
  expect(pending?.file).toBe(file);
  // The library read the safe version before the edit, but its review was queued
  // behind the config scan that held the newer proposal.
  expect(
    (await f.service.reviewTheme(file, original, parseThemeFile(original, "theme")))?.parsed,
  ).toEqual(parseThemeFile(original, "theme"));
  expect(f.service.status().pending).toEqual(pending);
  await f.decide("keep");
  expect(await f.read(file)).toBe(original);
});

test("a delayed library review cannot resurrect a removed theme or its approval baseline", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.service.refresh();
  await rm(path.join(f.folder, file));
  await f.service.refresh();
  expect(
    await f.service.reviewTheme(file, original, parseThemeFile(original, "theme")),
  ).toBeUndefined();
  expect(f.themeBaselines.has(file)).toBe(false);
  expect(f.service.status().pending).toBeNull();
});

test("inactive themes and hue-only warnings apply; file selection is held and UI selection is direct", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: palette.colors.ink }),
  );
  await f.service.refresh();
  expect(f.service.status().pending).toBeNull();
  await f.settings({ interfaceTheme: "user:personal.json" });
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("interfaceTheme: attention-distinctness");
  await f.decide("keep");
  await f.selectTheme("personal.json");
  expect(f.service.status().pending).toBeNull();
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: "#3ee0ff" }),
  );
  await f.service.refresh();
  expect(f.service.status().pending).toBeNull();
});

test("Keep rechecks a proposed theme weakened by an independent library review", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const interfaceTheme = "user:personal.json";
  await f.write(file, theme("Personal"));
  await f.settings({ hooks: false, interfaceTheme, interfaceScale: 120 });
  const pending = (await f.service.refresh()).pending;
  expect(pending?.detail).toBe("hooks: on → off");

  const warned = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write(file, warned);
  const parsed = parseThemeFile(warned, "theme");
  // The independent library callback runs before the settings watcher rescans.
  expect(await f.service.reviewTheme(file, warned, parsed)).toEqual({
    parsed,
    digest: digest(warned),
  });
  expect(f.service.status().pending).toEqual(pending);
  await expect(f.service.decide("keep", pending?.id)).rejects.toThrow("file changed");
  expect(f.service.status().pending?.detail).toContain("interfaceTheme: attention-distinctness");
  expect((await f.decide("keep")).pending).toBeNull();

  expect(f.applied.at(-1)).toEqual({ interfaceScale: 120 });
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    interfaceScale: 120,
  });
  expect(f.copy()).toBe(await f.read("settings.json"));
  expect((await f.service.refresh()).pending).toBeNull();
  const again = await restart(f);
  expect(again.status().pending).toBeNull();
});

test.each(["save", "keep"])(
  "a palette weakened at the settings rename stays unapproved after %s",
  async (decision) => {
    const { promise: renaming, resolve: atRename } = Promise.withResolvers<undefined>();
    const { promise: resume, resolve: finishRename } = Promise.withResolvers<undefined>();
    let pause = false;
    const f = await fixture({
      rename: async (from, to) => {
        if (pause && to === path.join(f.folder, "settings.json")) {
          pause = false;
          atRename(undefined);
          await resume;
        }
        await rename(from, to);
      },
    });
    await f.service.initialize();
    const file = "themes/personal.json";
    const interfaceTheme = "user:personal.json";
    const warned = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
    await f.write(file, theme("Personal"));
    await f.settings({ hooks: false, interfaceTheme, interfaceScale: 110 });
    expect((await f.service.refresh()).pending?.detail).toBe("hooks: on → off");
    // Put the warned palette in the library, then expose safe bytes only
    // for the locked preflight. No config watcher runs during the write.
    await f.write(file, warned);
    await f.service.reviewTheme(file, warned, parseThemeFile(warned, "theme"));
    await f.write(file, theme("Personal"));
    pause = true;
    const saving =
      decision === "save" ? f.service.write({ interfaceScale: 120 }) : f.decide("keep");
    await renaming;
    try {
      await f.write(file, warned);
    } finally {
      finishRename(undefined);
    }
    await saving;

    const interfaceScale = decision === "save" ? 120 : 110;
    expect(JSON.parse(await f.read("settings.json"))).toEqual({
      kind: "settings",
      ...(decision === "save" ? { hooks: false } : {}),
      interfaceTheme,
      interfaceScale,
    });
    expect(f.applied.at(-1)).toEqual({ interfaceScale });
    expect(f.applied.every((values) => values.interfaceTheme !== interfaceTheme)).toBe(true);
    expect(JSON.parse(f.copy() ?? "")).toEqual({ kind: "settings", interfaceScale });
    expect(f.baseline()).toBe(digest(f.copy() ?? ""));
    const detail =
      (decision === "save" ? "hooks: on → off, " : "") + "interfaceTheme: attention-distinctness";
    expect(f.service.status().pending?.detail).toBe(detail);
    expect((await f.service.refresh()).pending?.detail).toBe(detail);
    expect((await restart(f)).status().pending?.detail).toBe(detail);
  },
);

test("an invalid palette cannot inherit approval from a cached safe palette on selection", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const safe = theme("Personal");
  await f.write(file, safe);
  await f.service.reviewTheme(file, safe, parseThemeFile(safe, "theme"));
  await f.write(file, "{");
  await f.settings({ interfaceTheme: "user:personal.json" });
  await f.service.write({ interfaceScale: 120 });
  expect(f.applied.at(-1)).toEqual({ interfaceScale: 120 });
  expect(f.service.status().pending?.detail).toBe("interfaceTheme: palette unavailable");
});

test("a replaced theme proposal cannot be approved, and invalid replacements clear the obsolete hold", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/personal.json", theme("Personal"));
  await f.service.refresh();
  await f.selectTheme("personal.json");
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: palette.colors.ink }),
  );
  await f.service.refresh();
  const id = f.service.status().pending?.id;
  await f.write("themes/personal.json", "{");
  await expect(f.service.decide("allow", id)).rejects.toThrow("file changed");
  expect(f.service.status().pending).toBeNull();
  expect(f.service.status().rejected).toEqual([
    { file: "themes/personal.json", reason: "$: malformed-json" },
  ]);
});

test("file selection checks the warned palette retained after an invalid edit", async () => {
  const f = await fixture();
  await f.service.initialize();
  const library = new ThemeLibrary(f.folder, undefined, (file, text, parsed) =>
    f.service.reviewTheme(file, text, parsed),
  );
  try {
    await library.initialize();
    await f.write(
      "themes/personal.json",
      theme("Personal", {
        ...palette.colors,
        attention: palette.colors.ink,
      }),
    );
    await library.reload();
    await f.service.refresh();
    const retained = library.snapshot().interface;
    expect(retained).toHaveLength(1);
    await f.write("themes/personal.json", "{");
    await library.reload();
    await f.service.refresh();
    expect(library.snapshot().interface).toEqual(retained);
    await f.settings({ interfaceTheme: "user:personal.json" });
    expect((await f.service.refresh()).pending?.detail).toBe(
      "interfaceTheme: attention-distinctness, interfaceTheme: palette unavailable",
    );
    expect(f.applied.at(-1)?.interfaceTheme).not.toBe("user:personal.json");
    await f.decide("keep");
    expect(f.service.status().pending).toBeNull();
    await f.settings({ interfaceTheme: "user:personal.json" });
    await f.service.refresh();
    await f.decide("allow");
    expect(f.applied.at(-1)?.interfaceTheme).toBe("user:personal.json");
  } finally {
    library.dispose();
  }
});

test("an accepted area warning does not approve a newly weakened area", async () => {
  const f = await fixture();
  await f.service.initialize();
  const menu = { attention: palette.colors.ink };
  const original = JSON.stringify({
    version: 2,
    name: "Personal",
    base: palette.base,
    colors: palette.colors,
    areas: { menus: menu },
  });
  const proposed = JSON.stringify({
    version: 2,
    name: "Personal",
    base: palette.base,
    colors: palette.colors,
    areas: { menus: menu, sidebar: menu },
  });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.selectTheme("personal.json");
  await f.service.refresh();
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  expect(
    (
      await f.service.reviewTheme(
        "themes/personal.json",
        proposed,
        parseThemeFile(proposed, "theme"),
      )
    )?.parsed,
  ).toEqual(parseThemeFile(original, "theme"));
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect((await f.service.refresh()).pending).toBeNull();
  expect(
    (
      await f.service.reviewTheme(
        "themes/personal.json",
        proposed,
        parseThemeFile(proposed, "theme"),
      )
    )?.parsed,
  ).toEqual(parseThemeFile(proposed, "theme"));
});

test("a theme an agent weakened while Foom was closed is held after a restart", async () => {
  const f = await fixture();
  await f.service.initialize();
  const original = theme("Personal");
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.selectTheme("personal.json");
  expect(f.themeBaselines.get("themes/personal.json")).toBe(digest(original));
  // While Foom is closed, an agent weakens the active theme.
  await f.service.dispose();
  const weak = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", weak);
  const again = await restart(f);
  expect(again.status().pending).toMatchObject({ file: "themes/personal.json" });
  // The file's palette is the weak one, so nothing from it is shown.
  expect(
    await again.reviewTheme("themes/personal.json", weak, parseThemeFile(weak, "theme")),
  ).toBeUndefined();
  // With no safe version to restore, Keep it on leaves the theme and keeps the file.
  await again.decide("keep", again.status().pending?.id);
  expect(again.status().pending).toBeNull();
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({
    interfaceTheme: DEFAULT_SETTINGS.interfaceTheme,
  });
  expect(await f.read("themes/personal.json")).toBe(weak);
});

test("a theme this profile approved stays approved after a restart", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/personal.json", theme("Personal"));
  await f.service.refresh();
  await f.selectTheme("personal.json");
  const weak = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", weak);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.themeBaselines.get("themes/personal.json")).toBe(digest(weak));
  const again = await restart(f);
  expect(again.status().pending).toBeNull();
  expect(
    (await again.reviewTheme("themes/personal.json", weak, parseThemeFile(weak, "theme")))?.parsed,
  ).toEqual(parseThemeFile(weak, "theme"));
  // Removing the file forgets its baseline.
  await rm(path.join(f.folder, "themes/personal.json"));
  await again.refresh();
  expect(f.themeBaselines.has("themes/personal.json")).toBe(false);
});

test("an approved attention conflict does not approve a new one on the same color", async () => {
  const f = await fixture();
  await f.service.initialize();
  // Approved: needs-you matches done. Proposed: it now also matches muted text.
  const original = theme("Personal", { ...palette.colors, attention: palette.colors.done });
  const proposed = theme("Personal", {
    ...palette.colors,
    attention: palette.colors.done,
    muted: palette.colors.done,
  });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.selectTheme("personal.json");
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
});

test("new area, gradient-stop and scrollbar attention conflicts use the existing approval gate", async () => {
  for (const areas of [
    { "tile-headers": { attention: palette.colors.ink } },
    {
      sidebar: {
        bg: "#000000",
        gradient: {
          angle: 90,
          stops: [
            ["#000000", 0],
            ["#020202", 100],
          ],
        },
      },
    },
    { board: { scrollbar: "#010101" } },
  ]) {
    const f = await fixture();
    await f.service.initialize();
    const file = "themes/extended.json";
    // Explicit UI selection approves existing global conflicts, not new area/stop pairs.
    const original = JSON.stringify({
      ...palette,
      version: 2,
      colors: { ...palette.colors, attention: "#010101" },
    });
    await f.write(file, original);
    await f.service.refresh();
    await f.selectTheme("extended.json");
    const proposed = JSON.stringify({
      ...palette,
      version: 2,
      colors: { ...palette.colors, attention: "#010101" },
      areas,
    });
    await f.write(file, proposed);
    expect((await f.service.refresh()).pending?.detail).toBe("attention-distinctness");
    expect(
      (await f.service.reviewTheme(file, proposed, parseThemeFile(proposed, "theme")))?.parsed,
    ).toEqual(parseThemeFile(original, "theme"));
    await f.decide("keep");
    expect(await f.read(file)).toBe(original);
  }
});

test.each(["save", "scan"])(
  "a %s activates the checked palette even when the catalog still has warned bytes",
  async (operation) => {
    const f = await fixture();
    await f.service.initialize();
    const file = "themes/personal.json";
    const id = "user:personal.json";
    const safe = theme("Personal");
    const warned = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
    const library = new ThemeLibrary(
      f.folder,
      undefined,
      (file, text, parsed) => f.service.reviewTheme(file, text, parsed),
      () => f.service.activePalette(),
    );
    await f.write(file, warned);
    try {
      await library.initialize();
    } finally {
      // Freeze the last published catalog until after the config operation.
      library.dispose();
    }
    expect(library.snapshot().interface[0]?.theme.colors.attention).toBe(palette.colors.ink);
    await f.write(file, safe);
    await f.settings({ interfaceTheme: id });
    const files = new ConfigFiles({ root: f.folder });
    const read = files.read.bind(files);
    let paletteReads = 0;
    const barrier = vi.spyOn(ConfigFiles.prototype, "read").mockImplementation(async (relative) => {
      const bytes = await read(relative);
      if (relative === file && ++paletteReads === (operation === "save" ? 3 : 2))
        await f.write(file, warned);
      return bytes;
    });
    try {
      if (operation === "save") await f.service.write({ interfaceScale: 120 });
      else await f.service.refresh();
    } finally {
      barrier.mockRestore();
    }
    expect(f.applied.at(-1)?.interfaceTheme).toBe(id);
    expect(library.snapshot().interface[0]?.theme.colors.attention).toBe(palette.colors.attention);
    expect(f.themeBaselines.get(file)).toBe(digest(safe));
    expect((await f.service.refresh()).pending?.file).toBe(file);
    expect((await restart(f)).status().pending?.file).toBe(file);
  },
);

test("Allow requires a new review when a proposed palette changes during argument confirmation", async () => {
  const { promise: open, resolve: opened } = Promise.withResolvers<undefined>();
  const { promise: reply, resolve: answer } = Promise.withResolvers<boolean>();
  const f = await fixture({
    confirmArguments: () => {
      opened(undefined);
      return reply;
    },
  });
  await f.service.initialize();
  const file = "themes/personal.json";
  await f.write(file, theme("Personal"));
  const proposal = {
    interfaceTheme: "user:personal.json",
    agentArguments: { claude: ["--verbose"] },
  };
  await f.settings(proposal);
  const pending = (await f.service.refresh()).pending;
  expect(pending?.detail).toBe("agentArguments.claude");
  const result = f.decide("allow");
  await open;
  try {
    await f.write(file, theme("Personal", { ...palette.colors, attention: palette.colors.ink }));
  } finally {
    answer(true);
  }
  await expect(result).rejects.toThrow("file changed");
  expect(f.applied.at(-1)).toEqual({});
  expect(f.service.status().pending).toMatchObject({
    detail: "agentArguments.claude, interfaceTheme: attention-distinctness",
  });
  expect(f.service.status().pending?.id).not.toBe(pending?.id);
  await f.decide("allow");
  expect(f.applied.at(-1)).toEqual(proposal);
});

test("theme Revert without a cached palette preserves another profile's new selection", async () => {
  const owner = await fixture();
  const other = await fixture({ root: owner.folder });
  await owner.service.initialize();
  const file = "themes/personal.json";
  await owner.write(file, theme("Personal"));
  await owner.selectTheme("personal.json");
  await other.service.initialize();
  await owner.write(file, theme("Personal", { ...palette.colors, attention: palette.colors.ink }));
  const restarted = await restart(owner);
  const held = restarted.status().pending;
  expect(held?.file).toBe(file);
  await other.service.write({ interfaceTheme: "moonlight", interfaceScale: 130 });
  const saved = await owner.read("settings.json");
  await expect(restarted.decide("keep", held?.id)).rejects.toThrow("file changed");
  expect(await owner.read("settings.json")).toBe(saved);
  expect(restarted.status().pending).toBeNull();
});

test("a failed profile replacement after palette fallback retains the approved copy on restart", async () => {
  const f = await fixture();
  const profile = path.join(f.root, "profile");
  const backup = path.join(f.root, "saved-profile");
  const file = "themes/personal.json";
  const interfaceTheme = "user:personal.json";
  const warned = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  let blockProfile = false;
  const create = async () => {
    const store = await SettingsStore.open(profile);
    const service = new ConfigService({
      root: f.folder,
      defaults: configPart(DEFAULT_SETTINGS),
      apply: (values) => {
        store.setConfig(values);
      },
      baseline: {
        get: () => store.configDigest(),
        copy: () => store.configText(),
        set: (digest, text, palette) => store.setConfigBaseline(digest, text, palette),
      },
      themeBaseline: {
        get: (file) => store.themeDigest(file),
        set: (file, digest) => store.setThemeDigest(file, digest),
      },
      rename: async (from, to) => {
        await rename(from, to);
        if (blockProfile && to === path.join(f.folder, "settings.json")) {
          await f.write(file, warned);
          await rename(profile, backup);
          await writeFile(profile, "");
        }
      },
      watch: () => ({ close() {} }),
    });
    services.push(service);
    const values = await service.initialize();
    await store.attachConfig((patch) => service.write(patch), values, store.configDigest());
    return { service, store };
  };
  const first = await create();
  const agentArguments = { claude: ["--verbose"] };
  await first.store.update({ agentArguments });
  const approved = first.store.configText();
  await f.write(file, theme("Personal"));
  await f.settings({ interfaceTheme });
  blockProfile = true;
  try {
    await first.service.write({ interfaceScale: 120 });
    expect(first.store.get().interfaceTheme).toBe(DEFAULT_SETTINGS.interfaceTheme);
    expect(first.store.configText()).toBe(approved);
    expect(first.store.configDigest()).toBe(digest(approved ?? ""));
  } finally {
    blockProfile = false;
    await rm(profile);
    await rename(backup, profile);
  }
  await first.service.dispose();
  const restarted = await create();
  expect(restarted.store.get().agentArguments).toEqual(agentArguments);
  await restarted.service.decide("keep", restarted.service.status().pending?.id);
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({
    agentArguments,
    interfaceScale: 120,
  });
});

test("the library exposes an approved active palette before its first catalog reload", async () => {
  const f = await fixture();
  await f.service.initialize();
  const library = new ThemeLibrary(
    f.folder,
    undefined,
    (file, text, parsed) => f.service.reviewTheme(file, text, parsed),
    () => f.service.activePalette(),
  );
  expect(library.snapshot().interface).toEqual([]);
  await f.write("themes/new.json", theme("New palette"));
  await f.settings({ interfaceTheme: "user:new.json" });
  await f.service.refresh();
  expect(library.snapshot().interface).toEqual([
    {
      id: "user:new.json",
      theme: { ...palette, name: "New palette" },
      digest: digest(theme("New palette")),
    },
  ]);
});

test("Appearance refuses palette bytes that differ from the offered catalog snapshot", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const interfaceTheme = "user:personal.json";
  const original = theme("Personal");
  const weakened = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  const library = new ThemeLibrary(f.folder, undefined, (file, text, parsed) =>
    f.service.reviewTheme(file, text, parsed),
  );
  await f.write(file, original);
  try {
    await library.initialize();
  } finally {
    library.dispose();
  }
  const offered = library.snapshot().interface[0];
  expect(offered?.digest).toBe(digest(original));
  const before = await f.read("settings.json");
  await f.write(file, weakened);
  await expect(f.service.write({ interfaceTheme }, offered?.digest)).rejects.toThrow(
    "theme-selection-changed",
  );
  expect(await f.read("settings.json")).toBe(before);
  expect(f.themeBaselines.has(file)).toBe(false);
  expect(f.service.activePalette()).toBeUndefined();
  await f.write(file, original);
  await expect(f.service.write({ interfaceTheme })).rejects.toThrow("theme-selection-changed");
  await f.service.write({ interfaceTheme }, offered?.digest);
  expect(f.themeBaselines.get(file)).toBe(offered?.digest);
});

test("theme Keep succeeds when the reconciliation scan finds Settings busy", async () => {
  const replace = vi.fn(rename);
  const f = await fixture({ rename: replace });
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.selectTheme("personal.json");
  await f.write(file, theme("Personal", { ...palette.colors, attention: palette.colors.ink }));
  expect((await f.service.refresh()).pending?.file).toBe(file);
  const lock = vi.spyOn(ConfigFiles.prototype, "withSettingsLock");
  replace.mockImplementationOnce(async (from, to) => {
    await rename(from, to);
    await f.settings({ interfaceTheme: "user:personal.json", hooks: false });
    lock.mockRejectedValueOnce(new ApplicationError("settings-busy"));
  });
  try {
    await expect(f.decide("keep")).resolves.toMatchObject({ pending: null });
    expect(await f.read(file)).toBe(original);
    await vi.waitFor(() => {
      expect(f.service.status().pending?.file).toBe("settings.json");
    });
    expect(lock).toHaveBeenCalledTimes(3);
  } finally {
    lock.mockRestore();
  }
});

const illustrated = (images: object, colors = palette.colors) =>
  JSON.stringify({ ...palette, colors, name: "Illustrated", version: 2, images });
const artFile = "themes/art.json";
const artTheme = "user:art.json";
const art = { empty: { files: ["first.png", "second.png"] }, sidebar: { file: "sidebar.png" } };

async function artFixture(deferThemeDecoding = false) {
  const normalize = vi.fn((png: Uint8Array) =>
    Promise.resolve({ png, colors: [palette.colors.attention] }),
  );
  const load = vi.fn((parsed: Parameters<ThemeBitmaps["load"]>[0]) => bitmaps.load(parsed));
  const changed = vi.fn();
  const f = await fixture({
    loadThemeBitmaps: load,
    deferThemeDecoding,
    onThemeBitmapsChanged: changed,
  });
  const directory = path.join(f.folder, "themes");
  const bitmaps = new ThemeBitmaps(directory, normalize);
  return { ...f, load, normalize, changed, bitmaps, directory };
}

test("artwork selection, placement and byte changes apply automatically and revoke removed IDs", async () => {
  const f = await artFixture();
  try {
    await f.service.initialize();
    const text = illustrated(art);
    await f.write(artFile, text);
    await f.write("themes/first.png", "first artwork");
    await f.write("themes/second.png", "second artwork");
    await f.write("themes/sidebar.png", "sidebar artwork");
    const offer = await f.service.reviewTheme(artFile, text, parseThemeFile(text, "theme"));
    expect(offer?.digest).toBe(digest(text));
    expect(f.normalize).not.toHaveBeenCalled();

    await f.settings({ interfaceTheme: artTheme });
    expect((await f.service.refresh()).pending).toBeNull();
    const original = f.service.activePalette()?.bitmaps?.empty;
    expect(original).toHaveLength(2);
    const id = original?.[0]?.id ?? "";
    const request = new Request(`foom-theme://bitmap/${id}`);
    const response = () => themeBitmapResponse(request, (key) => f.service.activeThemeImage(key));
    expect(response().status).toBe(200);

    await f.write("themes/first.png", "replacement artwork");
    await f.write(artFile, illustrated({ ...art, empty: { ...art.empty, opacity: 0.6 } }));
    expect((await f.service.refresh()).pending).toBeNull();
    expect(f.service.activePalette()?.bitmaps?.empty).toMatchObject([
      { opacity: 0.6 },
      { opacity: 0.6 },
    ]);
    expect(response().status).toBe(404);
    const replacement = f.service.activePalette()?.bitmaps?.empty?.[0]?.id ?? "";
    expect(f.service.activeThemeImage(replacement)).toBeDefined();

    await rm(path.join(f.directory, "first.png"));
    expect((await f.service.refresh()).pending).toBeNull();
    expect(f.service.activePalette()?.bitmaps?.empty).toHaveLength(1);
    expect(f.service.activeThemeImage(replacement)).toBeUndefined();
    expect(f.service.activePalette()?.bitmaps?.sidebar).toHaveLength(1);

    await rename(f.directory, path.join(f.folder, "moved"));
    expect((await f.service.refresh()).pending).toBeNull();
    expect(f.service.activePalette()?.theme?.name).toBe("Illustrated");
    expect(f.service.activePalette()?.bitmaps).toBeUndefined();
    expect(f.changed).toHaveBeenCalled();
  } finally {
    f.bitmaps.dispose();
  }
});

test("deferred artwork does not gate an active palette and inactive artwork stays undecoded", async () => {
  const f = await artFixture(true);
  try {
    await mkdir(f.directory, { recursive: true });
    await f.write(artFile, illustrated(art));
    await f.write("themes/first.png", "first artwork");
    await f.write("themes/inactive.json", illustrated({ empty: { file: "inactive.png" } }));
    await f.write("themes/inactive.png", "inactive artwork");
    await f.settings({ interfaceTheme: artTheme, concurrentChildren: 1 });
    const settings = await f.service.initialize();
    expect(settings.concurrentChildren).toBe(1);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.service.activePalette()?.bitmaps).toBeUndefined();
    expect((await f.service.startThemeDecoding()).pending).toBeNull();
    expect(f.service.activePalette()?.bitmaps?.empty).toHaveLength(1);
    expect(f.normalize).toHaveBeenCalledOnce();
    expect(f.normalize.mock.calls[0]?.[0].toString()).toBe("first artwork");
    const restarted = await restart(f, { loadThemeBitmaps: f.load });
    expect(restarted.activePalette()?.theme?.name).toBe("Illustrated");
    expect(restarted.status().pending).toBeNull();
  } finally {
    f.bitmaps.dispose();
  }
});

test.each(["current", "legacy"])(
  "offline artwork placement edits preserve a %s approval after migration",
  async (baseline) => {
    const f = await artFixture();
    try {
      const colors = { ...palette.colors, attention: palette.colors.ink };
      const file = { file: "first.png", opacity: 0.25 };
      const original = illustrated({ empty: file }, colors);
      await f.service.initialize();
      await f.write("themes/first.png", "first artwork");
      await f.write(artFile, original);
      await f.selectTheme("art.json");
      expect(f.service.activePalette()?.bitmaps?.empty?.[0]?.opacity).toBe(0.25);
      await f.service.dispose();

      if (baseline === "legacy") {
        f.themeBaselines.set(artFile, digest(original));
        const upgraded = await restart(f);
        expect(upgraded.status().pending).toBeNull();
        await upgraded.dispose();
      }
      const approved = f.themeBaselines.get(artFile);
      expect(approved && typeof approved === "object" && approved.paletteDigest).toMatch(
        /^[0-9a-f]{64}$/u,
      );

      const edited = { empty: { ...file, opacity: 0.5 } };
      await f.write(artFile, illustrated(edited, colors));
      const restarted = await restart(f, { loadThemeBitmaps: f.load, deferThemeDecoding: true });
      expect(restarted.status().pending).toBeNull();
      expect(restarted.activePalette()?.theme?.colors.attention).toBe(colors.attention);
      expect((await restarted.startThemeDecoding()).pending).toBeNull();
      expect(restarted.activePalette()?.bitmaps?.empty?.[0]?.opacity).toBe(0.5);
      expect(f.themeBaselines.get(artFile)).toEqual(approved);
      await restarted.dispose();

      const weakened = JSON.stringify({
        ...palette,
        version: 2,
        name: "Illustrated",
        colors,
        images: edited,
        areas: { tiles: { failed: colors.attention } },
      });
      await f.write(artFile, weakened);
      const held = await restart(f);
      expect(held.status().pending?.detail).toBe("attention-distinctness");
      expect(held.activePalette()?.theme).toBeUndefined();
      expect(f.themeBaselines.get(artFile)).toEqual(approved);
    } finally {
      f.bitmaps.dispose();
    }
  },
);

test("artwork warnings never add an approval or change the palette gate", async () => {
  const f = await artFixture();
  try {
    await f.service.initialize();
    const original = illustrated(art);
    await f.write(artFile, original);
    await f.write("themes/first.png", "first artwork");
    await f.selectTheme("art.json");
    const originalApproval = f.themeBaselines.get(artFile);
    expect(originalApproval).toBeDefined();
    const weakened = illustrated(
      { empty: { file: "new.png" } },
      { ...palette.colors, attention: palette.colors.ink },
    );
    await f.write(artFile, weakened);
    await f.write("themes/new.png", "new artwork");
    const proposal = (await f.service.refresh()).pending;
    expect(proposal?.detail).toBe("attention-distinctness");
    expect(f.service.activePalette()?.theme?.colors.attention).toBe(palette.colors.attention);
    expect(f.themeBaselines.get(artFile)).toEqual(originalApproval);

    await f.write("themes/new.png", "changed artwork");
    expect((await f.service.refresh()).pending?.id).toBe(proposal?.id);
    await f.decide("allow");
    expect(f.service.activePalette()?.theme?.colors.attention).toBe(palette.colors.ink);
    expect(f.service.activePalette()?.bitmaps?.empty).toHaveLength(1);
    expect(f.themeBaselines.get(artFile)).not.toEqual(originalApproval);

    await f.service.write({ interfaceTheme: "follow" });
    await f.settings({ interfaceTheme: artTheme });
    expect((await f.service.refresh()).pending?.detail).toBe(
      "interfaceTheme: attention-distinctness",
    );
  } finally {
    f.bitmaps.dispose();
  }
});
