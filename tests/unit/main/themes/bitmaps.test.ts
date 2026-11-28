import { afterEach, expect, test, vi } from "vitest";
import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThemeBitmaps,
  ThemeLibrary,
  themeBitmapResponse,
} from "../../../../src/main/themes/library";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import { parseThemeFile } from "../../../../src/shared/theme-files";
import { IMAGE_BYTES } from "../../../../src/shared/image-paste";
import { ImageDecodeRejection } from "../../../../src/shared/theme-bitmaps";
import { themeDirectoryEntryLimit } from "../../../../src/main/theme-directory";

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const base = interfaceThemes["eclipse-dark"];
const text = JSON.stringify({
  ...base,
  version: 2,
  images: {
    board: { file: "private.png" },
    gutter: { file: "private.png", opacity: 0.5, fit: "tile" },
    sidebar: { file: "gone.webp" },
  },
});
const parsed = parseThemeFile(text, "theme");
if (parsed.kind !== "theme") throw Error("fixture");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-bitmap-unit-"));
  roots.push(root);
  const directory = join(root, "themes");
  await mkdir(directory);
  const file = join(directory, "private.png");
  const normalize = vi.fn((bytes: Uint8Array, _signal: AbortSignal) =>
    Promise.resolve({ png: bytes, colors: [base.colors.attention] }),
  );
  const bitmaps = new ThemeBitmaps(directory, normalize);
  disposers.push(() => {
    bitmaps.dispose();
  });
  return { root, directory, file, bitmaps, normalize };
}

test("deduplicates decoding, warns on reserved status colors and projects slots without file details", async () => {
  const { root, directory, file, normalize, bitmaps } = await fixture();
  await writeFile(file, "fixture pixels");
  const result = await bitmaps.load(parsed);
  expect(result.slots.board?.paint.id).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.slots.board?.paint).toMatchObject({
    opacity: 0.25,
    fit: "contain",
    anchor: "center",
  });
  expect(result.slots.gutter?.paint).toEqual({
    id: result.slots.board?.paint.id,
    opacity: 0.5,
    fit: "tile",
    anchor: "center",
  });
  expect(result.diagnostics).toEqual([
    { file: "", path: "$.images.board", severity: "warning", reason: "image-status-color" },
    { file: "", path: "$.images.gutter", severity: "warning", reason: "image-status-color" },
    { file: "", path: "$.images.sidebar", severity: "error", reason: "image-unavailable" },
  ]);
  const board = result.slots.board?.paint;
  const gutter = result.slots.gutter?.paint;
  if (!board || !gutter) throw new Error("Bitmap fixture missing");
  const library = new ThemeLibrary(
    root,
    undefined,
    () => Promise.resolve({ parsed, digest: "fixture", imageDiagnostics: result.diagnostics }),
    () => ({
      id: "user:sample.json",
      theme: base,
      bitmaps: { board, gutter },
      warnings: result.diagnostics.filter(({ severity }) => severity === "warning"),
    }),
  );
  disposers.push(() => {
    library.dispose();
  });
  await writeFile(join(directory, "sample.json"), text);
  await library.initialize();
  const catalog = library.snapshot();
  expect(catalog.activeBitmaps?.slots.board?.id).toBe(result.slots.board?.paint.id);
  expect(catalog.errors).toHaveLength(3);
  expect(JSON.stringify(catalog)).not.toMatch(/private\.png|gone\.webp|fixture pixels/u);
  await bitmaps.load(parsed);
  expect(normalize).toHaveBeenCalledOnce();
  bitmaps.dispose();
  expect(normalize.mock.calls[0]?.[1].aborted).toBe(true);
});

test("enforces byte and file budgets and surfaces a fixed decoder rejection", async () => {
  const { root, directory, file, normalize, bitmaps } = await fixture();
  await writeFile(file, "");
  await truncate(file, IMAGE_BYTES + 1);
  expect((await bitmaps.load(parsed)).diagnostics[0]?.reason).toBe("too-large");
  expect(normalize).not.toHaveBeenCalled();
  await writeFile(file, "unsupported encoded data");
  normalize.mockRejectedValueOnce(new ImageDecodeRejection("private decoder detail"));
  const result = await bitmaps.load(parsed);
  expect(result.diagnostics[0]).toEqual({
    file: "",
    path: "$.images.board",
    severity: "error",
    reason: "image-format",
  });
  expect(result.sources.board).toBeDefined();
  for (let i = 0; i < 50; i++) await writeFile(join(directory, `sample-${String(i)}.webp`), "");
  expect((await bitmaps.load(parsed)).diagnostics.map(({ reason }) => reason)).toEqual(
    Array.from({ length: 3 }, () => "too-many-files"),
  );
  await writeFile(join(directory, "sample.json"), text);
  const library = new ThemeLibrary(root);
  disposers.push(() => {
    library.dispose();
  });
  await library.initialize();
  expect(library.snapshot()).toMatchObject({
    interface: [],
    errors: [{ file: "sample.json", reason: "too-many-files" }],
  });
});

test.skipIf(process.platform === "win32")(
  "refuses in-folder links, hard links and subdirectories",
  async () => {
    const { directory, file, bitmaps, normalize } = await fixture();
    const target = join(directory, "target.png");
    await writeFile(target, "fixture pixels");
    await symlink(target, file);
    expect((await bitmaps.load(parsed)).diagnostics[0]?.reason).toBe("unsafe-file");
    await rm(file);
    await link(target, file);
    expect((await bitmaps.load(parsed)).diagnostics[0]?.reason).toBe("unsafe-file");
    await rm(file);
    await mkdir(file);
    expect((await bitmaps.load(parsed)).diagnostics[0]?.reason).toBe("unsafe-file");
    expect(normalize).not.toHaveBeenCalled();
  },
);

test("bitmap protocol resolves only exact GET IDs for currently approved images", async () => {
  const id = "d".repeat(64);
  const url = `foom-theme://bitmap/${id}`;
  const png = Uint8Array.of(1, 2, 3);
  const lookup = vi.fn((value: string) => (value === id ? png : undefined));
  for (const request of [
    new Request(`${url}?path=lost`),
    new Request(`foom-theme://other/${id}`),
    new Request(url, { method: "POST" }),
  ])
    expect(themeBitmapResponse(request, lookup).status).toBe(404);
  expect(lookup).not.toHaveBeenCalled();
  const response = themeBitmapResponse(new Request(url), lookup);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  expect(
    themeBitmapResponse(new Request(`foom-theme://bitmap/${"0".repeat(64)}`), lookup).status,
  ).toBe(404);
});

test("an unavailable folder omits all paint and a recovered sidebar uses its own palette", async () => {
  const { directory, file, bitmaps, normalize } = await fixture();
  await rm(directory, { recursive: true });
  for (const create of [() => Promise.resolve(), () => writeFile(directory, "not a directory")]) {
    await create();
    const snapshot = await bitmaps.load(parsed);
    expect(snapshot.slots).toEqual({});
    expect(snapshot.diagnostics.map(({ reason }) => reason)).toEqual(
      Array.from({ length: 3 }, () => "image-unavailable"),
    );
  }
  expect(normalize).not.toHaveBeenCalled();
  await rm(directory);
  await mkdir(directory);
  await writeFile(file, "board");
  await writeFile(join(directory, "gone.webp"), "sidebar");
  normalize.mockImplementationOnce((bytes) => Promise.resolve({ png: bytes, colors: [] }));
  normalize.mockImplementationOnce((bytes) => Promise.resolve({ png: bytes, colors: ["#00ffee"] }));
  const snapshot = await bitmaps.load({
    ...parsed,
    theme: { ...base, areas: { sidebar: { failed: "#00ffee" } } },
  });
  expect(snapshot.slots.sidebar?.paint).toBeDefined();
  expect(snapshot.diagnostics).toEqual([
    { file: "", path: "$.images.sidebar", severity: "warning", reason: "image-status-color" },
  ]);
});

test("an unchanged source recovers from a transient decode failure on a later refresh", async () => {
  const { file, normalize, bitmaps } = await fixture();
  await writeFile(file, "source");
  normalize.mockRejectedValueOnce(new Error("decoder timed out"));
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  expect((await bitmaps.load(parsed)).slots).toEqual({});
  expect((await bitmaps.load(parsed)).slots).toEqual({});
  expect(normalize).toHaveBeenCalledOnce();
  clock.mockReturnValue(2_001);
  expect((await bitmaps.load(parsed)).slots.board).toBeDefined();
  expect(normalize).toHaveBeenCalledTimes(2);
});

test.skipIf(process.platform === "win32")(
  "dangling links cannot occupy the bitmap or palette file budget",
  async () => {
    const { root, directory, file, bitmaps } = await fixture();
    await writeFile(file, "source");
    await writeFile(join(directory, "sample.json"), text);
    for (let i = 0; i < 50; i++) {
      await symlink("missing", join(directory, `dead-${String(i)}.png`));
      await symlink("missing", join(directory, `dead-${String(i)}.json`));
    }
    expect((await bitmaps.load(parsed)).slots.board).toBeDefined();
    const library = new ThemeLibrary(root);
    disposers.push(() => {
      library.dispose();
    });
    await library.initialize();
    expect(library.snapshot().interface.map(({ id }) => id)).toEqual(["user:sample.json"]);
  },
);

test("a deterministic refusal is reused and the directory scan is bounded independently", async () => {
  const { root, directory, file, normalize, bitmaps } = await fixture();
  await writeFile(file, "source");
  await writeFile(join(directory, "sample.json"), text);
  normalize.mockRejectedValueOnce(new ImageDecodeRejection("invalid raster"));
  expect((await bitmaps.load(parsed)).slots).toEqual({});
  expect((await bitmaps.load(parsed)).slots).toEqual({});
  expect(normalize).toHaveBeenCalledOnce();

  const library = new ThemeLibrary(root);
  disposers.push(() => {
    library.dispose();
  });
  await library.initialize();
  expect(library.snapshot().interface).toHaveLength(1);
  for (let i = 0; i < themeDirectoryEntryLimit - 1; i++)
    await writeFile(join(directory, `unrelated-${String(i)}.tmp`), "");
  await library.reload();
  expect(library.snapshot().errors).toContainEqual({
    kind: "theme",
    file: "(folder)",
    path: "$",
    reason: "too-many-files",
  });
  expect(library.snapshot().interface).toHaveLength(1);
  expect((await bitmaps.load(parsed)).diagnostics[0]?.reason).toBe("too-many-files");
  expect(normalize).toHaveBeenCalledOnce();
});
