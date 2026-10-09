import { beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow, Session, BrowserWindowConstructorOptions } from "electron";
import { resolveInterfaceTheme } from "../../../../src/shared/interface-themes";
const mock = vi.hoisted(() => ({
  autoSize: true,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  ipc: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as FakeWindow[],
  construct: vi.fn(),
  load: vi.fn<() => Promise<void>>(),
}));
class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "app://confirmation/confirmation.html" },
    send: vi.fn((_channel: string, request: unknown) => {
      if (request && mock.autoSize)
        queueMicrotask(() => {
          resize({ width: 440, height: 240 });
        });
    }),
    focus: vi.fn(),
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn<(handler: () => { action: string }) => void>(),
  });
  removeMenu = vi.fn();
  setBounds = vi.fn();
  setBackgroundColor = vi.fn();
  show = vi.fn();
  hide = vi.fn();
  focus = vi.fn();
  destroy = vi.fn();
  loadURL = mock.load;
  constructor(options: BrowserWindowConstructorOptions) {
    super();
    mock.construct(options);
    mock.windows.push(this);
  }
}
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(function (options: BrowserWindowConstructorOptions) {
    return new FakeWindow(options);
  }),
  screen: { getDisplayMatching: () => ({ workArea: mock.workArea }) },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => void) => mock.ipc.set(channel, fn),
    removeListener: (channel: string) => mock.ipc.delete(channel),
  },
}));
import { TrustedDialog } from "../../../../src/main/confirmations/trusted-dialog";
const theme = resolveInterfaceTheme("follow", false);
const parent = Object.assign(new EventEmitter(), {
  isEnabled: () => true,
  setEnabled: vi.fn(),
  webContents: { send: vi.fn(), getZoomFactor: vi.fn(() => 1) },
  getContentBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
  isDestroyed: vi.fn(() => false),
  focus: vi.fn(),
});
const content = {
  title: "Remove branch?",
  accept: "Discard 1 change and remove",
  changes: "?? x\0",
};
function setup() {
  return new TrustedDialog(parent as unknown as BrowserWindow, {} as Session, () => theme);
}
function window() {
  const value = mock.windows.at(-1);
  if (!value) throw Error("Missing window");
  return value;
}
function answer(
  id: unknown,
  accepted: unknown,
  event: unknown = { sender: window().webContents, senderFrame: window().webContents.mainFrame },
) {
  mock.ipc.get("confirmation:answer")?.(event, id, accepted);
}
async function shown() {
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalled();
    expect(window().webContents.send.mock.calls.at(-1)?.[1]).toHaveProperty("id");
  });
  const request: unknown = window().webContents.send.mock.calls.at(-1)?.[1];
  if (!request || typeof request !== "object" || !("id" in request)) throw Error("Missing request");
  return request.id;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.autoSize = true;
  mock.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  parent.webContents.getZoomFactor.mockReturnValue(1);
  parent.getContentBounds.mockReturnValue({ x: 10, y: 20, width: 800, height: 600 });
  mock.windows.length = 0;
  mock.ipc.clear();
  mock.load.mockResolvedValue();
  parent.isDestroyed.mockReturnValue(false);
  parent.removeAllListeners();
});
test("prewarms an isolated sandbox, rejects foreign frames, forged IDs and malformed answers", async () => {
  const dialog = setup();
  expect(window().show).not.toHaveBeenCalled();
  expect(mock.construct).toHaveBeenCalledWith(
    expect.objectContaining({
      modal: false,
      transparent: false,
      frame: false,
      show: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      }) as unknown,
    }),
  );
  const pending = dialog.request(content);
  const id = await shown();
  expect(window().webContents.send).toHaveBeenCalledWith("confirmation:render", {
    ...content,
    id,
    theme,
  });
  answer(id, true, { sender: {}, senderFrame: window().webContents.mainFrame });
  answer(id, true, {
    sender: window().webContents,
    senderFrame: { url: "app://confirmation/confirmation.html" },
  });
  answer("forged", true);
  answer(id, "yes");
  window().webContents.mainFrame.url = "app://bundle/index.html";
  answer(id, true);
  expect(window().hide).not.toHaveBeenCalled();
  window().webContents.mainFrame.url = "app://confirmation/confirmation.html";
  answer(id, false);
  await expect(pending).resolves.toBe(false);
  answer(id, true);
  expect(window().hide).toHaveBeenCalledOnce();
  expect(parent.focus).toHaveBeenCalledOnce();
  dialog.dispose();
  expect(mock.ipc.size).toBe(0);
});
test("serializes requests, denies navigation, cancels close, and disposes queued work", async () => {
  const dialog = setup();
  const first = dialog.request(content);
  const second = dialog.request(content);
  const id = await shown();
  const preventDefault = vi.fn();
  window().webContents.emit("will-navigate", { preventDefault });
  window().webContents.emit("will-attach-webview", { preventDefault });
  const opener = window().webContents.setWindowOpenHandler.mock.calls[0]?.[0];
  expect(opener?.()).toEqual({ action: "deny" });
  answer(id, true);
  await expect(first).resolves.toBe(true);
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalledTimes(2);
  });
  window().emit("close", { preventDefault });
  await expect(second).resolves.toBe(false);
  expect(preventDefault).toHaveBeenCalledTimes(3);
  const pending = dialog.request(content);
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalledTimes(3);
  });
  parent.isDestroyed.mockReturnValue(true);
  dialog.dispose();
  await expect(pending).resolves.toBe(false);
  await expect(dialog.request(content)).resolves.toBe(false);
});
test("page failures and crashes cancel; a subsequent request prepares a fresh renderer", async () => {
  mock.load.mockRejectedValue(Error("load failed"));
  const dialog = setup();
  await expect(dialog.request(content)).resolves.toBe(false);
  mock.load.mockResolvedValue();
  const pending = dialog.request(content);
  await shown();
  window().webContents.emit("render-process-gone");
  await expect(pending).resolves.toBe(false);
  const next = dialog.request(content);
  const id = await shown();
  answer(id, true);
  await expect(next).resolves.toBe(true);
  dialog.dispose();
});
test("tracks parent bounds and focus only while pending and restores input on cancellation", async () => {
  const dialog = setup();
  const pending = dialog.request(content);
  await shown();
  expect(parent.setEnabled).toHaveBeenLastCalledWith(false);
  window().setBounds.mockClear();
  window().focus.mockClear();
  parent.emit("move");
  parent.emit("resize");
  parent.emit("focus");
  expect(window().setBounds).toHaveBeenCalledTimes(2);
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 190, y: 200, width: 440, height: 240 });
  expect(window().focus).toHaveBeenCalledOnce();
  window().emit("close", { preventDefault: vi.fn() });
  await expect(pending).resolves.toBe(false);
  expect(parent.setEnabled).toHaveBeenLastCalledWith(true);
  expect(parent.listenerCount("move")).toBe(0);
  expect(parent.listenerCount("resize")).toBe(0);
  expect(parent.listenerCount("focus")).toBe(0);
  parent.emit("resize");
  expect(window().setBounds).toHaveBeenCalledTimes(2);
  dialog.dispose();
});

test("pairing deadlines dismiss active dialogs and cannot approve queued expired requests", async () => {
  const dialog = setup();
  const controller = new AbortController();
  const pending = dialog.request(content, controller.signal);
  const id = await shown();
  controller.abort();
  answer(id, true);
  expect(await pending).toBe(false);
  expect(await dialog.request(content, controller.signal)).toBe(false);
  dialog.dispose();
});

function resize(
  value: unknown,
  event: unknown = {
    sender: window().webContents,
    senderFrame: window().webContents.mainFrame,
  },
) {
  mock.ipc.get("confirmation:size")?.(event, value);
}
test("size requires a pending trusted main frame and finite positive dimensions before showing", async () => {
  mock.autoSize = false;
  const dialog = setup();
  resize({ width: 440, height: 240 });
  expect(window().setBounds).not.toHaveBeenCalled();
  const pending = dialog.request(content);
  await vi.waitFor(() => {
    expect(parent.setEnabled).toHaveBeenCalledWith(false);
  });
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", true);
  const valid = { width: 440, height: 240 };
  resize(valid, { sender: parent.webContents, senderFrame: window().webContents.mainFrame });
  resize(valid, {
    sender: window().webContents,
    senderFrame: { url: "app://confirmation/confirmation.html" },
  });
  window().webContents.mainFrame.url = "app://bundle/index.html";
  resize(valid);
  window().webContents.mainFrame.url = "app://confirmation/confirmation.html";
  for (const value of [
    null,
    false,
    {},
    { width: 1 },
    { width: "1", height: 2 },
    { width: 1, height: "2" },
    { width: NaN, height: 2 },
    { width: 1, height: Infinity },
    { width: -1, height: 2 },
    { width: 1, height: 0 },
  ])
    resize(value);
  expect(window().show).not.toHaveBeenCalled();
  expect(window().setBounds).not.toHaveBeenCalled();
  resize(valid);
  expect(window().show).toHaveBeenCalledOnce();
  expect(window().webContents.focus).toHaveBeenCalledOnce();
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 190, y: 200, width: 440, height: 240 });
  resize({ width: Number.MAX_VALUE, height: Number.MAX_VALUE });
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 34, y: 44, width: 752, height: 552 });
  mock.workArea = { x: 100, y: 100, width: 600, height: 400 };
  parent.emit("maximize");
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 600, height: 400 });
  parent.webContents.getZoomFactor.mockReturnValue(1.25);
  window().webContents.getZoomFactor.mockReturnValue(1.25);
  resize(valid);
  dialog.refresh();
  expect(window().webContents.setZoomFactor).toHaveBeenLastCalledWith(1.25);
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 135, y: 170, width: 550, height: 300 });
  parent.getContentBounds.mockReturnValue({ x: -1500, y: -1500, width: 800, height: 600 });
  parent.emit("move");
  expect(window().setBounds).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 550, height: 300 });
  window().emit("close", { preventDefault: vi.fn() });
  await expect(pending).resolves.toBe(false);
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
  window().setBounds.mockClear();
  resize(valid);
  parent.emit("restore");
  expect(window().setBounds).not.toHaveBeenCalled();
  dialog.dispose();
  dialog.refresh();
  resize(valid);
});
