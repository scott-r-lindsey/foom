import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { ThemeLibrary } from "../../../../src/main/themes/library";
const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
  openPath: vi.fn(() => Promise.resolve("")),
}));
vi.mock("electron", () => ({ ipcMain: mock, shell: mock }));
import { attachThemes } from "../../../../src/main/themes/ipc";
const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame };
const trusted = { sender: contents, senderFrame: frame };
const library = {
  reload: vi.fn(async () => {}),
  snapshot: vi.fn(() => ({ interface: [], terminal: [], errors: [] })),
  folder: vi.fn((kind: string) => `/private/${kind}`),
};
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = "app://bundle/index.html";
  dispose = attachThemes(
    { webContents: contents } as unknown as BrowserWindow,
    library as unknown as ThemeLibrary,
  );
});
function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error("missing handler");
  return handler(event, ...args);
}
test("checks sender, top frame, URL, kind and exact argument counts", () => {
  for (const channel of ["theme:list", "theme:open-folder"]) {
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: null },
      { sender: contents, senderFrame: { url: frame.url } },
    ])
      expect(() => invoke(channel, [], event)).toThrow("Untrusted");
    expect(() => invoke(channel, [{}, {}])).toThrow("arguments");
  }
  for (const args of [[], ["../other"], [{}]])
    expect(() => invoke("theme:open-folder", args)).toThrow("arguments");
  frame.url = "https://example.org";
  expect(() => invoke("theme:list")).toThrow("Untrusted");
});
test("lists parsed palettes, opens only fixed folders, hides native errors and disposes", async () => {
  await expect(invoke("theme:list")).resolves.toEqual({ interface: [], terminal: [], errors: [] });
  expect(library.reload).toHaveBeenCalledOnce();
  for (const kind of ["theme", "terminal-theme"]) {
    await invoke("theme:open-folder", [kind]);
    expect(mock.openPath).toHaveBeenLastCalledWith(`/private/${kind}`);
  }
  mock.openPath.mockResolvedValueOnce("private failure");
  await expect(invoke("theme:open-folder", ["theme"])).rejects.toThrow(
    /^Unable to complete theme request$/,
  );
  library.reload.mockRejectedValueOnce(new Error("secret filesystem path"));
  await expect(invoke("theme:list")).rejects.toThrow(/^Unable to complete theme request$/);
  dispose();
  expect(mock.removeHandler.mock.calls).toEqual([["theme:list"], ["theme:open-folder"]]);
});
