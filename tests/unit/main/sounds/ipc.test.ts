import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { SoundLibrary } from "../../../../src/main/sounds/library";
const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
  openPath: vi.fn(() => Promise.resolve("")),
  readFile: vi.fn(() => Promise.resolve("credits")),
}));
vi.mock("electron", () => ({ ipcMain: mock, shell: mock }));
vi.mock("node:fs/promises", () => ({ readFile: mock.readFile }));
import { attachSounds } from "../../../../src/main/sounds/ipc";
const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() };
const trusted = { sender: contents, senderFrame: frame };
const library = {
  list: vi.fn(() => Promise.resolve([])),
  read: vi.fn(() => Promise.resolve({ error: "missing" })),
  initialize: vi.fn(async () => {}),
  user: "/home/test/.foom/config/sounds",
};
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = "app://bundle/index.html";
  dispose = attachSounds(
    { webContents: contents } as unknown as BrowserWindow,
    library as unknown as SoundLibrary,
    "/app/sounds/NOTICES.txt",
  );
});
function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw Error("missing handler");
  return handler(event, ...args);
}
test("rejects foreign senders, child frames and extra arguments on every capability", () => {
  for (const [channel] of mock.handle.mock.calls) {
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: null },
      { sender: contents, senderFrame: { url: frame.url } },
    ])
      expect(() => invoke(channel, [], event)).toThrow("Untrusted");
    expect(() => invoke(channel, [{}, {}])).toThrow("arguments");
  }
  frame.url = "https://example.com";
  expect(() => invoke("sound:list")).toThrow("Untrusted");
  frame.url = "app://bundle/index.html";
  expect(() => invoke("sound:read")).toThrow("arguments");
  expect(library.read).not.toHaveBeenCalled();
  expect(library.list).not.toHaveBeenCalled();
});
test("lists and refreshes only a trusted live page, reads through validation and opens only the fixed folder", async () => {
  await expect(invoke("sound:list")).resolves.toEqual([]);
  expect(contents.send).toHaveBeenCalledWith("sound:changed");
  contents.send.mockClear();
  contents.isDestroyed.mockReturnValueOnce(true);
  await invoke("sound:list");
  expect(contents.send).not.toHaveBeenCalled();
  library.list.mockImplementationOnce(() => {
    frame.url = "https://example.com";
    return Promise.resolve([]);
  });
  await invoke("sound:list");
  expect(contents.send).not.toHaveBeenCalled();
  frame.url = "app://bundle/index.html";
  const choice = { source: "user", kind: "done", file: "bell.wav" };
  await invoke("sound:read", [choice]);
  expect(library.read).toHaveBeenCalledWith(choice);
  await invoke("sound:open-folder");
  expect(library.initialize).toHaveBeenCalledOnce();
  expect(mock.openPath).toHaveBeenCalledWith(library.user);
  mock.openPath.mockResolvedValueOnce("os error");
  await expect(invoke("sound:open-folder")).rejects.toThrow("Unable to complete sound request");
  await expect(invoke("sound:notices")).resolves.toBe("credits");
  expect(mock.readFile).toHaveBeenCalledWith("/app/sounds/NOTICES.txt", "utf8");
  dispose();
  expect(mock.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
    mock.handle.mock.calls.map(([channel]) => channel),
  );
});

test("filesystem failures do not expose main-owned paths over the bridge", async () => {
  library.list.mockRejectedValueOnce(new Error("EACCES /private/home/sounds"));
  await expect(invoke("sound:list")).rejects.toThrow(/^Unable to complete sound request$/);
  mock.readFile.mockRejectedValueOnce(new Error("ENOENT /private/app/NOTICES.txt"));
  await expect(invoke("sound:notices")).rejects.toThrow(/^Unable to complete sound request$/);
});
