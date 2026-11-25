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
      "interfaceTheme: attention-distinctness",
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
      if (relative === file && ++paletteReads === (operation === "save" ? 2 : 1))
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

test("bitmap approval binds original bytes, revokes deleted slots and rejects stale decisions", async () => {
  const changed = vi.fn();
  const f = await fixture({
    loadThemeBitmaps: (parsed) => bitmaps.load(parsed),
    onThemeBitmapsChanged: changed,
  });
  const bitmaps = new ThemeBitmaps(path.join(f.folder, "themes"), () =>
    // All versions have the same normalized image, even when their source bytes differ.
    Promise.resolve({ png: Uint8Array.of(1, 2, 3), colors: [palette.colors.attention] }),
  );
  const file = "themes/art.json";
  const image = "themes/private.png";
  const text = JSON.stringify({
    ...palette,
    name: "Illustrated",
    version: 2,
    images: { board: { file: "private.png" } },
  });
  await f.service.initialize();
  await f.write(file, text);
  await f.write(image, "original source");
  await f.service.refresh();
  const offered = await f.service.reviewTheme(file, text, parseThemeFile(text, "theme"));
  expect(offered?.imageDiagnostics).toMatchObject([{ reason: "image-status-color" }]);
  expect(offered?.digest).not.toBe(digest(text));
  await f.write(image, "different metadata");
  await expect(
    f.service.write({ interfaceTheme: "user:art.json" }, offered?.digest),
  ).rejects.toThrow();
  expect(f.service.activePalette()).toBeUndefined();

  await f.settings({ interfaceTheme: "user:art.json" });
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("interfaceTheme: theme-images");
  await f.decide("allow");
  const active = f.service.activePalette();
  const id = active?.bitmaps?.board?.id ?? "";
  expect(id).toMatch(/^[a-f0-9]{64}$/u);
  expect(f.service.activeThemeImage(id)).toEqual(Uint8Array.of(1, 2, 3));
  expect(f.service.activeThemeImage("anything")).toBeUndefined();
  expect(f.themeBaselines.get(file)).toMatchObject({ digest: active?.digest });

  await f.write(image, "proposed metadata");
  await f.service.refresh();
  const pending = f.service.status().pending;
  expect(pending?.detail).toBe("theme-images");
  expect(f.service.activePalette()).toEqual(active);
  await f.write(image, "new revision before approval");
  await expect(f.service.decide("allow", pending?.id)).rejects.toThrow("changed");
  expect(f.service.status().pending?.id).not.toBe(pending?.id);
  await f.decide("allow");
  const replacement = f.service.activePalette()?.bitmaps?.board?.id ?? "";
  expect(replacement).not.toBe(id);
  expect(f.service.activeThemeImage(id)).toBeUndefined();
  expect(f.service.activeThemeImage(replacement)).toBeDefined();
  expect(f.service.status().pending).toBeNull();

  await rm(path.join(f.folder, image));
  await f.service.refresh();
  expect(f.service.activePalette()).toMatchObject({ id: "user:art.json" });
  expect(f.service.activePalette()?.bitmaps).toBeUndefined();
  expect(f.service.activeThemeImage(replacement)).toBeUndefined();
  expect(f.service.status().pending).toBeNull();
  expect(changed).toHaveBeenCalledTimes(3);
  bitmaps.dispose();
});

test("Keep restores bitmap placement edits and switches to Default if original bytes changed", async () => {
  const f = await fixture({ loadThemeBitmaps: (parsed) => bitmaps.load(parsed) });
  const bitmaps = new ThemeBitmaps(path.join(f.folder, "themes"), () =>
    Promise.resolve({ png: Uint8Array.of(1), colors: [] }),
  );
  const file = "themes/art.json";
  const image = "themes/some.png";
  const text = (opacity: number) =>
    JSON.stringify({
      ...palette,
      version: 2,
      images: { board: { file: "some.png", opacity } },
    });
  await f.service.initialize();
  await f.write(file, text(0.25));
  await f.write(image, "original");
  const offer = await f.service.reviewTheme(file, text(0.25), parseThemeFile(text(0.25), "theme"));
  await f.service.write({ interfaceTheme: "user:art.json" }, offer?.digest);
  await f.write(file, text(0.6));
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("theme-images");
  await f.decide("keep");
  expect(await f.read(file)).toBe(text(0.25));
  await f.write(image, "replacement");
  await f.service.refresh();
  await f.decide("keep");
  expect(f.service.activePalette()).toBeUndefined();
  expect(await f.read(image)).toBe("replacement");
  bitmaps.dispose();
});

async function realBitmapFixture() {
  const { default: sharp } = await import("sharp");
  const { decodeThemeBitmap } = await import("../../../../src/main/image-decode");
  const f = await fixture({ loadThemeBitmaps: (parsed) => bitmaps.load(parsed) });
  const directory = path.join(f.folder, "themes");
  const bitmaps = new ThemeBitmaps(directory, decodeThemeBitmap);
  const file = "themes/art.json";
  const original = JSON.stringify({
    ...palette,
    name: "Art",
    version: 2,
    images: {
      board: { file: "board.png" },
      sidebar: { file: "sidebar.png" },
      gutter: { file: "gutter.png" },
    },
  });
  const image = async (name: string, color: string) => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: color } })
      .png()
      .toBuffer();
    await writeFile(path.join(directory, name), png);
  };
  await f.service.initialize();
  await f.write(file, original);
  await image("board.png", "#6633bb");
  await image("sidebar.png", "#3366bb");
  const offered = await f.service.reviewTheme(file, original, parseThemeFile(original, "theme"));
  await f.service.write({ interfaceTheme: "user:art.json" }, offered?.digest);
  return { ...f, file, original, directory, image, bitmaps };
}

test("a missing-file edit is held and Keep restores the original bitmap declaration", async () => {
  const f = await realBitmapFixture();
  const previous = f.service.activePalette();
  const baseline = f.themeBaselines.get(f.file);
  await f.write(f.file, f.original.replace("board.png", "missing.png"));
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("theme-images");
  expect(f.service.activePalette()).toEqual(previous);
  expect(f.themeBaselines.get(f.file)).toEqual(baseline);

  await f.image("missing.png", "#336688");
  await f.service.refresh();
  await f.decide("keep");
  expect(await f.read(f.file)).toBe(f.original);
  expect(f.service.activePalette()).toEqual(previous);
  f.bitmaps.dispose();
});

test("restart preserves the palette and other slot when an approved bitmap was deleted", async () => {
  const f = await realBitmapFixture();
  const previous = f.service.activePalette();
  const baseline = f.themeBaselines.get(f.file);
  await f.service.dispose();
  await rm(path.join(f.directory, "board.png"));
  const service = await restart(f, { loadThemeBitmaps: (parsed) => f.bitmaps.load(parsed) });
  expect(service.status().pending).toBeNull();
  expect(service.activePalette()).toEqual({
    ...previous,
    bitmaps: { sidebar: previous?.bitmaps?.sidebar },
  });
  expect(f.themeBaselines.get(f.file)).toEqual(baseline);

  await f.image("board.png", "#6633bb");
  await service.refresh();
  expect(service.status().pending).toBeNull();
  expect(service.activePalette()).toEqual(previous);

  await f.image("board.png", "#224455");
  await service.refresh();
  expect(service.status().pending?.detail).toBe("theme-images");
  expect(f.themeBaselines.get(f.file)).toEqual(baseline);
  f.bitmaps.dispose();
});

test("refresh revokes the active asset URLs when the theme folder disappears", async () => {
  const f = await realBitmapFixture();
  const asset = f.service.activePalette()?.bitmaps?.board?.id ?? "";
  const url = new Request(`foom-theme://bitmap/${asset}`);
  const response = () => themeBitmapResponse(url, (id) => f.service.activeThemeImage(id));
  const baseline = f.themeBaselines.get(f.file);
  expect(response().status).toBe(200);
  await rm(f.directory, { recursive: true });
  await f.service.refresh();
  expect(response().status).toBe(404);
  expect(f.service.activePalette()?.theme?.name).toBe("Art");
  expect(f.service.activePalette()?.bitmaps).toBeUndefined();
  expect(f.themeBaselines.get(f.file)).toEqual(baseline);
  f.bitmaps.dispose();
});

test("restart holds changed and newly added bytes while preserving approved missing hashes", async () => {
  const f = await realBitmapFixture();
  const initial = f.themeBaselines.get(f.file);
  if (!initial || typeof initial === "string") throw new Error("Missing bitmap approval");
  await f.service.dispose();
  await rm(path.join(f.directory, "board.png"));
  await f.image("sidebar.png", "#115588");
  await f.image("gutter.png", "#118855");
  const service = await restart(f, { loadThemeBitmaps: (parsed) => f.bitmaps.load(parsed) });

  expect(service.status().pending?.detail).toBe("theme-images");
  expect(service.activePalette()?.theme?.name).toBe("Art");
  expect(service.activePalette()?.bitmaps).toBeUndefined();
  expect(f.themeBaselines.get(f.file)).toEqual(initial);
  await service.decide("allow", service.status().pending?.id);
  expect(service.activePalette()?.bitmaps).toHaveProperty("gutter.id");
  expect(service.activePalette()?.bitmaps).toHaveProperty("sidebar.id");
  expect(f.themeBaselines.get(f.file)).toMatchObject({ sources: { board: initial.sources.board } });

  await f.image("board.png", "#6633bb");
  await service.refresh();
  expect(service.status().pending).toBeNull();
  expect(service.activePalette()?.bitmaps).toHaveProperty("board.id");
  f.bitmaps.dispose();
});

test.each(["settings", "Appearance", "active Allow"] as const)(
  "a failed decode during %s does not approve bytes on restart",
  async (method) => {
    const { default: sharp } = await import("sharp");
    const { decodeThemeBitmap } = await import("../../../../src/main/image-decode");
    const f = await fixture({ loadThemeBitmaps: (parsed) => bitmaps.load(parsed) });
    const directory = path.join(f.folder, "themes");
    const bitmaps = new ThemeBitmaps(directory, () =>
      Promise.reject(new Error("decode timed out")),
    );
    const file = "themes/art.json";
    const text = JSON.stringify({
      ...palette,
      name: "Art",
      version: 2,
      images: { board: { file: "board.png" } },
    });
    await f.service.initialize();
    if (method === "active Allow") {
      await f.write(file, theme("Art"));
      await f.selectTheme("art.json");
    }
    await f.write(file, text);
    await writeFile(
      path.join(directory, "board.png"),
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "#6633bb" } })
        .png()
        .toBuffer(),
    );
    if (method === "Appearance") {
      const offer = await f.service.reviewTheme(file, text, parseThemeFile(text, "theme"));
      await f.service.write({ interfaceTheme: "user:art.json" }, offer?.digest);
    } else if (method === "active Allow") {
      await f.service.refresh();
      expect(f.service.status().pending?.detail).toBe("theme-images");
      await f.decide("allow");
    } else {
      await f.settings({ interfaceTheme: "user:art.json" });
      await f.service.refresh();
    }
    expect(f.service.activePalette()?.bitmaps).toBeUndefined();
    const baseline = f.themeBaselines.get(file);
    const recovered = new ThemeBitmaps(directory, decodeThemeBitmap);
    const service = await restart(f, { loadThemeBitmaps: (parsed) => recovered.load(parsed) });
    expect(service.activePalette()?.bitmaps).toBeUndefined();
    expect(service.status().pending?.detail).toBe("theme-images");
    expect(baseline).toMatchObject({ sources: {} });
    await service.decide("allow", service.status().pending?.id);
    expect(service.activePalette()?.bitmaps?.board).toBeDefined();
    bitmaps.dispose();
    recovered.dispose();
  },
);

test("Keep re-holds a newer JSON edit written while the approved bitmap is revalidated", async () => {
  let beforeRead: (() => Promise<void>) | undefined;
  const f = await fixture({
    loadThemeBitmaps: async (parsed) => {
      if (parsed.images?.board?.opacity === 0.25) await beforeRead?.();
      return bitmaps.load(parsed);
    },
  });
  const { default: sharp } = await import("sharp");
  const { decodeThemeBitmap } = await import("../../../../src/main/image-decode");
  const directory = path.join(f.folder, "themes");
  const bitmaps = new ThemeBitmaps(directory, decodeThemeBitmap);
  const file = "themes/paint.json";
  const theme = (opacity: number) =>
    JSON.stringify({
      ...palette,
      version: 2,
      images: { board: { file: "board.png", opacity } },
    });
  await f.service.initialize();
  await f.write(file, theme(0.25));
  await writeFile(
    path.join(directory, "board.png"),
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#6633bb" } })
      .png()
      .toBuffer(),
  );
  const offer = await f.service.reviewTheme(
    file,
    theme(0.25),
    parseThemeFile(theme(0.25), "theme"),
  );
  await f.service.write({ interfaceTheme: "user:paint.json" }, offer?.digest);
  await f.write(file, theme(0.4));
  await f.service.refresh();
  const pending = f.service.status().pending?.id;
  beforeRead = async () => {
    beforeRead = undefined;
    await f.write(file, theme(0.6));
  };
  await expect(f.service.decide("keep", pending)).rejects.toThrow("file changed");
  expect(await f.read(file)).toBe(theme(0.6));
  expect(f.service.status().pending).toMatchObject({ detail: "theme-images" });
  expect(f.service.status().pending?.id).not.toBe(pending);
  bitmaps.dispose();
});

test.each(["Appearance", "Allow"] as const)(
  "a recovered decode cannot join the older %s offer",
  async (method) => {
    let recover = false;
    const f = await fixture({
      loadThemeBitmaps: async (parsed) => {
        const loaded = await bitmaps.load(parsed);
        if (recover) return loaded;
        const slots = { ...loaded.slots };
        delete slots.board;
        return { ...loaded, slots };
      },
    });
    const { decodeThemeBitmap } = await import("../../../../src/main/image-decode");
    const { default: sharp } = await import("sharp");
    const directory = path.join(f.folder, "themes");
    const bitmaps = new ThemeBitmaps(directory, decodeThemeBitmap);
    const file = "themes/offer.json";
    const text = JSON.stringify({
      ...palette,
      version: 2,
      images: { board: { file: "paint.png" }, sidebar: { file: "paint.png" } },
    });
    await f.service.initialize();
    await f.write(file, text);
    await writeFile(
      path.join(directory, "paint.png"),
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "#6633bb" } })
        .png()
        .toBuffer(),
    );
    const offered = await f.service.reviewTheme(file, text, parseThemeFile(text, "theme"));
    if (method === "Appearance") {
      recover = true;
      await expect(
        f.service.write({ interfaceTheme: "user:offer.json" }, offered?.digest),
      ).rejects.toThrow("theme-selection-changed");
    } else {
      await f.settings({ interfaceTheme: "user:offer.json" });
      await f.service.refresh();
      const pending = f.service.status().pending?.id;
      recover = true;
      await expect(f.service.decide("allow", pending)).rejects.toThrow("changed");
      expect(f.service.status().pending?.id).not.toBe(pending);
    }
    expect(f.service.activePalette()).toBeUndefined();
    expect(f.themeBaselines.has(file)).toBe(false);
    bitmaps.dispose();
  },
);
