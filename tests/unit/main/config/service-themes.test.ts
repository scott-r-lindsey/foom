import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { digest } from "../../../../src/main/config/layout";
import { ThemeLibrary } from "../../../../src/main/themes/library";
import { parseThemeFile } from "../../../../src/shared/theme-files";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { fixture, palette, theme, restart } from "./service-fixture";

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
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  expect(f.service.status().pending).toMatchObject({
    file: "themes/personal.json",
    detail: "attention-distinctness",
  });
  const { parseThemeFile } = await import("../../../../src/shared/theme-files");
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(original, "theme"));
  await expect(f.service.decide("allow", "old")).rejects.toThrow("replaced");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.service.status().pending).toBeNull();
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(proposed, "theme"));
});

test("a delayed library review cannot clear a newer held theme edit", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write(file, proposed);
  await f.service.refresh();
  const pending = f.service.status().pending;
  expect(pending?.file).toBe(file);
  // The library read the safe version before the edit, but its review was queued
  // behind the config scan that held the newer proposal.
  expect(await f.service.reviewTheme(file, original, parseThemeFile(original, "theme"))).toEqual(
    parseThemeFile(original, "theme"),
  );
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
  await f.service.write({ interfaceTheme: "user:personal.json" });
  expect(f.service.status().pending).toBeNull();
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: "#3ee0ff" }),
  );
  await f.service.refresh();
  expect(f.service.status().pending).toBeNull();
});

test("a replaced theme proposal cannot be approved, and invalid replacements clear the obsolete hold", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/personal.json", theme("Personal"));
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
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
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.service.refresh();
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(original, "theme"));
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect((await f.service.refresh()).pending).toBeNull();
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(proposed, "theme"));
});

test("a theme an agent weakened while Foom was closed is held after a restart", async () => {
  const f = await fixture();
  await f.service.initialize();
  const original = theme("Personal");
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
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
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const weak = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", weak);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.themeBaselines.get("themes/personal.json")).toBe(digest(weak));
  const again = await restart(f);
  expect(again.status().pending).toBeNull();
  expect(
    await again.reviewTheme("themes/personal.json", weak, parseThemeFile(weak, "theme")),
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
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
});
