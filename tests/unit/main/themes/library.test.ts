import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThemeLibrary } from "../../../../src/main/themes/library";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import { ansiNames, terminalThemes } from "../../../../src/shared/terminal-themes";
const roots: string[] = [];
const libraries: ThemeLibrary[] = [];
afterEach(async () => {
  for (const library of libraries.splice(0)) library.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const valid = () => ({
  kind: "theme",
  name: "Eclipse Dark",
  base: "dark",
  colors: { ...interfaceThemes["eclipse-dark"].colors },
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-themes-"));
  roots.push(root);
  const changed = vi.fn();
  const library = new ThemeLibrary(join(root, "config"), changed);
  libraries.push(library);
  await library.initialize();
  return { root, library, changed, folder: library.folder("theme") };
}
test("loads namespaced palettes, disambiguates names, returns copies and retains rejected edits", async () => {
  const { library, folder, changed } = await fixture();
  const file = join(folder, "eclipse-dark.json");
  await writeFile(file, JSON.stringify(valid()));
  await library.reload();
  const previous = library.snapshot().interface;
  expect(previous).toHaveLength(1);
  expect(previous[0]).toMatchObject({
    id: "user:eclipse-dark.json",
    theme: { name: "Eclipse Dark (custom)" },
  });
  for (const [input, reason] of [
    ["{", "malformed-json"],
    [" ".repeat(65537), "too-large"],
    [JSON.stringify({ ...valid(), id: "eclipse-dark" }), "unknown-key"],
    [
      JSON.stringify({
        ...valid(),
        colors: { ...valid().colors, ink: "url(https://example.org)" },
      }),
      "not-a-color",
    ],
    [
      JSON.stringify({ ...valid(), colors: { ...valid().colors, accent: "#ffb23e" } }),
      "reserved-color",
    ],
    [
      JSON.stringify({
        ...valid(),
        colors: { ...valid().colors, highlight: "#ff2e88", "highlight-deep": "#7a3cff" },
      }),
      "reserved-color",
    ],
    [
      JSON.stringify({ ...valid(), colors: { ...valid().colors, ink: valid().colors.bg } }),
      "contrast",
    ],
  ]) {
    if (input === undefined) throw new Error("fixture");
    await writeFile(file, input);
    await library.reload();
    expect(library.snapshot().interface).toEqual(previous);
    expect(library.snapshot().errors).toEqual([
      expect.objectContaining({ file: "eclipse-dark.json", reason }),
    ]);
  }
  const fresh = new ThemeLibrary(join(folder, ".."));
  libraries.push(fresh);
  await fresh.initialize();
  expect(fresh.snapshot().interface).toEqual([]);
  await writeFile(file, JSON.stringify({ ...valid(), name: "Restored" }));
  await library.reload();
  expect(library.snapshot().interface[0]?.theme.name).toBe("Restored");
  expect(library.snapshot().errors).toEqual([]);
  changed.mockClear();
  await library.reload();
  expect(changed).not.toHaveBeenCalled();
  await rm(file);
  await library.reload();
  expect(library.snapshot().interface).toEqual([]);
});
test("terminal palettes share the live registry and names cannot shadow built-ins", async () => {
  const { library } = await fixture();
  const theme = terminalThemes.dracula;
  await writeFile(
    join(library.folder("terminal-theme"), "dracula.json"),
    JSON.stringify({
      kind: "terminal-theme",
      name: "Dracula",
      background: theme.background,
      foreground: theme.foreground,
      cursor: theme.cursor,
      ansi: ansiNames.map((key) => theme[key]),
    }),
  );
  await library.reload();
  expect(library.snapshot().terminal[0]).toMatchObject({
    id: "user:dracula.json",
    name: "Dracula (custom)",
    theme: { foreground: theme.foreground },
  });
});
test("rejects unsafe names, directories, oversized files and files beyond fifty", async () => {
  const { library, folder } = await fixture();
  await writeFile(join(folder, ".hidden.json"), "{}");
  await writeFile(join(folder, "a".repeat(101) + ".json"), "{}");
  await mkdir(join(folder, "directory.json"));
  for (let i = 0; i < 51; i++)
    await writeFile(
      join(folder, `theme-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(valid()),
    );
  await library.reload();
  expect(library.snapshot().interface).toHaveLength(50);
  expect(library.snapshot().errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "unsafe-file" }),
      expect.objectContaining({ reason: "too-many-files" }),
    ]),
  );
});
test.skipIf(process.platform === "win32")(
  "confines symlinks and retains a previously valid replaced file",
  async () => {
    const { library, folder, root } = await fixture();
    const file = join(folder, "good.json");
    await writeFile(file, JSON.stringify(valid()));
    await library.reload();
    await writeFile(join(root, "outside.json"), JSON.stringify(valid()));
    await rm(file);
    await symlink(join(root, "outside.json"), file);
    await library.reload();
    expect(library.snapshot().interface).toHaveLength(1);
    expect(library.snapshot().errors[0]?.reason).toBe("unsafe-file");
    await writeFile(join(folder, "inside.json"), JSON.stringify(valid()));
    await symlink(join(folder, "inside.json"), join(folder, "link.json"));
    await library.reload();
    expect(library.snapshot().interface).toHaveLength(3);
  },
);
test("watches additions and atomic replacements, stops notifications on disposal", async () => {
  const { library, folder, changed } = await fixture();
  const file = join(folder, "watch.json");
  await writeFile(file, JSON.stringify(valid()));
  await vi.waitFor(
    () => {
      expect(library.snapshot().interface).toHaveLength(1);
    },
    { timeout: 3000 },
  );
  await writeFile(join(folder, "temp"), JSON.stringify({ ...valid(), name: "Edited" }));
  await rename(join(folder, "temp"), file);
  await vi.waitFor(
    () => {
      expect(library.snapshot().interface[0]?.theme.name).toBe("Edited");
    },
    {
      timeout: 3000,
    },
  );
  library.dispose();
  changed.mockClear();
  await writeFile(file, "{");
  await library.reload();
  expect(changed).not.toHaveBeenCalled();
});
test("unavailable folders report a fixed error and recover", async () => {
  const { library, folder } = await fixture();
  await rm(folder, { recursive: true });
  await writeFile(folder, "blocked");
  await library.initialize();
  expect(library.snapshot().errors).toContainEqual({
    kind: "theme",
    file: "(folder)",
    path: "$",
    reason: "unreadable",
  });
  await rm(folder);
  await mkdir(folder);
  await writeFile(join(folder, "new.json"), JSON.stringify(valid()));
  await library.reload();
  expect(library.snapshot().interface).toHaveLength(1);
});

test("an unavailable directory retains its known themes until recovery", async () => {
  const { library, folder } = await fixture();
  await writeFile(join(folder, "keep.json"), JSON.stringify(valid()));
  await library.reload();
  await rename(folder, `${folder}-saved`);
  await writeFile(folder, "blocked");
  await library.reload();
  expect(library.snapshot().interface).toHaveLength(1);
  expect(library.snapshot().errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ file: "keep.json", reason: "unsafe-file" })]),
  );
  library.dispose();
  await library.initialize();
});

test("retained unsafe replacements still consume a registry slot", async () => {
  const { library, folder } = await fixture();
  const file = join(folder, "old.json");
  await writeFile(file, JSON.stringify(valid()));
  await library.reload();
  await rm(file);
  await mkdir(file);
  for (let i = 0; i < 50; i++)
    await writeFile(join(folder, `new-${String(i)}.json`), JSON.stringify(valid()));
  await library.reload();
  expect(library.snapshot().interface).toHaveLength(50);
  expect(library.snapshot().interface.some((entry) => entry.id === "user:old.json")).toBe(true);
  expect(library.snapshot().errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: "old.json", reason: "unsafe-file" }),
      expect.objectContaining({ reason: "too-many-files" }),
    ]),
  );
});
