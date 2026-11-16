import type * as FsPromises from "node:fs/promises";
import type * as Fs from "node:fs";
import { writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const fsMock = vi.hoisted(() => ({
  opened: undefined as undefined | ((file: FsPromises.FileHandle, path: string) => Promise<void>),
  watchers: [] as Fs.FSWatcher[],
  controlled: false,
  notifications: [] as {
    directory: string;
    closed: boolean;
    deliver: () => void;
  }[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      await fsMock.opened?.(file, String(args[0]));
      return file;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      const watcher = fsMock.controlled ? fs.watch(args[0]) : fs.watch(...args);
      if (fsMock.controlled) {
        const listener = args[1];
        if (typeof listener !== "function") throw new Error("Expected watcher listener");
        const notification = {
          directory: String(args[0]),
          closed: false,
          deliver: () => {
            listener("change", "race.json");
          },
        };
        fsMock.notifications.push(notification);
        const close = watcher.close.bind(watcher);
        vi.spyOn(watcher, "close").mockImplementation(() => {
          notification.closed = true;
          close();
        });
      }
      fsMock.watchers.push(watcher);
      return watcher;
    },
  };
});
import { ThemeLibrary } from "../../../../src/main/themes/library";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
const roots: string[] = [];
const libraries: ThemeLibrary[] = [];
afterEach(async () => {
  fsMock.opened = undefined;
  for (const library of libraries.splice(0)) library.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  fsMock.watchers = [];
  fsMock.controlled = false;
  fsMock.notifications = [];
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-theme-race-"));
  roots.push(root);
  const library = new ThemeLibrary(root);
  libraries.push(library);
  await library.initialize();
  return { root, library };
}
const theme = JSON.stringify({
  kind: "theme",
  name: "Safe",
  base: "dark",
  colors: interfaceThemes["eclipse-dark"].colors,
});
test("a replacement during a descriptor read cannot supply an uninspected palette", async () => {
  const { library } = await fixture();
  const path = join(library.folder("theme"), "race.json");
  await writeFile(path, theme);
  await library.reload();
  fsMock.opened = async (_file, target) => {
    if (target !== path) return;
    fsMock.opened = undefined;
    await rename(path, `${path}.old`);
    await writeFile(path, theme);
  };
  await library.reload();
  expect(library.snapshot().errors).toContainEqual({
    kind: "theme",
    file: "race.json",
    path: "$",
    reason: "unsafe-file",
  });
  expect(library.snapshot().interface).toHaveLength(1);
});
test("growth after stat stays bounded and cannot replace a last-good palette", async () => {
  const { library } = await fixture();
  const path = join(library.folder("theme"), "growing.json");
  await writeFile(path, theme);
  await library.reload();
  fsMock.opened = (file, target) => {
    if (target !== path) return Promise.resolve();
    fsMock.opened = undefined;
    const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => {
      const info = await stat();
      await appendFile(path, " ".repeat(65537));
      return info;
    });
    return Promise.resolve();
  };
  await library.reload();
  expect(library.snapshot().errors[0]?.reason).toBe("too-large");
  expect(library.snapshot().interface).toHaveLength(1);
});
test("watch errors close and rebuild subscriptions; queued events after disposal do nothing", async () => {
  const { library } = await fixture();
  const watcher = fsMock.watchers.at(-1);
  if (!watcher) throw new Error("watcher missing");
  const reload = vi.spyOn(library, "reload");
  watcher.emit("error", new Error("watch failed"));
  await vi.waitFor(
    () => {
      expect(reload).toHaveBeenCalled();
    },
    { timeout: 2000 },
  );
  library.dispose();
  reload.mockClear();
  watcher.emit("change", "rename", "file.json");
  expect(reload).not.toHaveBeenCalled();
});

test("an edit after the palette read survives publication and watcher reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-theme-publication-"));
  roots.push(root);
  fsMock.controlled = true;
  let editAfterRead = false;
  let pending: (typeof fsMock.notifications)[number] | undefined;
  const light = { ...interfaceThemes["eclipse-light"], name: "Light edit" };
  const file = join(root, "themes", "race.json");
  const library = new ThemeLibrary(
    root,
    () => {},
    (_file, _text, parsed) => {
      if (editAfterRead) {
        editAfterRead = false;
        // An editor changes the file after the current read. Its native watcher
        // notification is pending until the next event-loop turn.
        writeFileSync(file, JSON.stringify({ kind: "theme", ...light }));
        pending = fsMock.notifications.findLast(
          (entry) => !entry.closed && entry.directory === dirname(file),
        );
      }
      return Promise.resolve(parsed);
    },
  );
  libraries.push(library);
  await library.initialize();
  await writeFile(file, theme);
  editAfterRead = true;
  await library.reload();
  expect(library.snapshot().interface[0]?.theme.base).toBe("dark");
  // A closed native watcher cannot deliver its queued callback. A replacement
  // watcher did not observe this edit and need not replay the old event.
  expect(pending).toBeDefined();
  if (pending && !pending.closed) pending.deliver();
  await vi.waitFor(() => {
    expect(library.snapshot().interface[0]?.theme).toEqual(light);
  });
});
