import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  activate: vi.fn(),
  power: undefined as EventEmitter | undefined,
  screen: undefined as EventEmitter | undefined,
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
  bounds = { x: 0, y: 0, width: 440, height: 240 };
  setBounds = vi.fn((bounds: typeof this.bounds) => {
    this.bounds = bounds;
  });
  getBounds = vi.fn(() => this.bounds);
  setBackgroundColor = vi.fn();
  show = vi.fn();
  setParentWindow = vi.fn();
  moveTop = vi.fn();
  isVisible = vi.fn(() => true);
  isFocused = vi.fn(() => true);
  isMinimized = vi.fn(() => false);
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
  app: { focus: mock.activate },
  BrowserWindow: vi.fn(function (options: BrowserWindowConstructorOptions) {
    return new FakeWindow(options);
  }),
  powerMonitor: {
    on: (event: string, listener: () => void) => mock.power?.on(event, listener),
    removeListener: (event: string, listener: () => void) =>
      mock.power?.removeListener(event, listener),
  },
  screen: {
    getDisplayMatching: () => ({ workArea: mock.workArea }),
    on: (event: string, listener: () => void) => mock.screen?.on(event, listener),
    removeListener: (event: string, listener: () => void) =>
      mock.screen?.removeListener(event, listener),
  },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => void) => mock.ipc.set(channel, fn),
    removeListener: (channel: string) => mock.ipc.delete(channel),
  },
}));
import { TrustedDialog, CONFIRMATION_URL } from "../../../../src/main/confirmations/trusted-dialog";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const theme = resolveInterfaceTheme("follow", false);
const parent = Object.assign(new EventEmitter(), {
  isEnabled: () => true,
  setEnabled: vi.fn(),
  isFocusable: vi.fn(() => true),
  isVisible: vi.fn(() => true),
  isMinimized: vi.fn(() => false),
  setFocusable: vi.fn(),
  webContents: Object.assign(new EventEmitter(), {
    send: vi.fn(),
    focus: vi.fn(),
    getZoomFactor: vi.fn(() => 1),
  }),
  getContentBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
  isDestroyed: vi.fn(() => false),
  focus: vi.fn(),
});
const content = {
  title: "Remove branch?",
  accept: "Discard 1 change and remove",
  changes: "?? x\0",
};
function setup(platform: NodeJS.Platform = "linux") {
  return new TrustedDialog(
    parent as unknown as BrowserWindow,
    {} as Session,
    () => theme,
    platform,
  );
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
  mock.power = new EventEmitter();
  mock.screen = new EventEmitter();
  mock.autoSize = true;
  mock.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  parent.webContents.getZoomFactor.mockReturnValue(1);
  parent.getContentBounds.mockReturnValue({ x: 10, y: 20, width: 800, height: 600 });
  mock.windows.length = 0;
  mock.ipc.clear();
  mock.load.mockResolvedValue();
  parent.isDestroyed.mockReturnValue(false);
  parent.removeAllListeners();
  parent.webContents.removeAllListeners();
  parent.isFocusable.mockReturnValue(true);
  parent.isVisible.mockReturnValue(true);
  parent.isMinimized.mockReturnValue(false);
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
        backgroundThrottling: false,
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
    presented: false,
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
  expect(parent.setEnabled).not.toHaveBeenCalled();
  window().setBounds.mockClear();
  window().focus.mockClear();
  parent.getContentBounds.mockReturnValue({ x: 30, y: 40, width: 800, height: 600 });
  parent.emit("move");
  parent.emit("resize");
  parent.emit("focus");
  expect(window().setBounds).toHaveBeenCalledOnce();
  expect(window().getBounds()).toEqual({ x: 210, y: 220, width: 440, height: 240 });
  expect(window().focus).toHaveBeenCalledOnce();
  window().emit("close", { preventDefault: vi.fn() });
  await expect(pending).resolves.toBe(false);
  expect(parent.setEnabled).not.toHaveBeenCalled();
  expect(parent.listenerCount("move")).toBe(0);
  expect(parent.listenerCount("resize")).toBe(0);
  expect(parent.listenerCount("focus")).toBe(0);
  parent.emit("resize");
  expect(window().setBounds).toHaveBeenCalledOnce();
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

test("an X11 frame/gravity adjustment cannot turn an unchanged placement into a visible move", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup();
  let mapped = false;
  const child = window();
  const visibleMoves: (typeof child.bounds)[] = [];
  child.show.mockImplementation(() => {
    mapped = true;
  });
  child.hide.mockImplementation(() => {
    mapped = false;
  });
  child.setBounds.mockImplementation((bounds) => {
    // Model a WM interpreting a mapped ConfigureRequest with frame/gravity
    // compensation. Repeating the pre-map coordinates drops the card 20 DIP.
    child.bounds = { ...bounds, y: bounds.y + (mapped ? 20 : 0) };
    if (mapped) visibleMoves.push(child.bounds);
  });
  for (let request = 0; request < 2; request++) {
    const pending = dialog.request(content);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.getBounds()).toEqual({ x: 190, y: 200, width: 440, height: 240 });
    resize({ width: 440, height: 240 });
    parent.emit("resize");
    parent.emit("focus");
    await vi.advanceTimersByTimeAsync(6000);
    expect(visibleMoves).toEqual([]);
    const render: unknown = child.webContents.send.mock.calls.at(-1)?.[1];
    if (!render || typeof render !== "object" || !("id" in render)) throw Error("Missing request");
    answer(render.id, true);
    expect(await pending).toBe(true);
  }
  dialog.dispose();
});

test.each(["linux", "darwin", "win32"] as const)(
  "%s still reapplies bounds when mapping really changes native geometry",
  async (platform) => {
    const dialog = setup(platform);
    const child = window();
    child.show.mockImplementation(() => {
      child.bounds = { ...child.bounds, y: child.bounds.y + 20 };
    });
    const pending = dialog.request(content);
    const id = await shown();
    expect(child.setBounds).toHaveBeenCalledTimes(2);
    expect(child.getBounds()).toEqual({ x: 190, y: 200, width: 440, height: 240 });
    answer(id, true);
    expect(await pending).toBe(true);
    dialog.dispose();
  },
);

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
    expect(parent.webContents.send).toHaveBeenCalledWith("confirmation:scrim", true);
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
  await shown();
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

test("live cleanup updates stay in the trusted window; malformed actions cannot start or stop it", async () => {
  const dialog = setup();
  let publish = () => {};
  let stage: "checking" | "ready" | "run" = "checking";
  const action = vi.fn();
  const unsubscribe = vi.fn();
  const feed = {
    current: () => ({
      stage,
      progress: { total: 1, done: 0, phase: "fetch" as const, stopped: false, items: [] },
    }),
    subscribe: (listener: () => void) => {
      publish = listener;
      return unsubscribe;
    },
    act: action,
  };
  const result = dialog.request({ ...content, feed });
  const id = await shown();
  expect(window().webContents.send.mock.calls.at(-1)?.[1]).not.toHaveProperty("feed");
  answer(id, "true");
  answer("stale", true);
  answer(id, true, { sender: parent.webContents, senderFrame: window().webContents.mainFrame });
  answer(id, true, { sender: window().webContents, senderFrame: { url: CONFIRMATION_URL } });
  expect(action).not.toHaveBeenCalled();
  stage = "ready";
  publish();
  expect(window().webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
    cleanup: { stage: "ready" },
  });
  answer(id, true);
  expect(action).toHaveBeenCalledOnce();
  stage = "run";
  publish();
  answer(id, true);
  expect(action).toHaveBeenCalledTimes(2);
  answer(id, false);
  expect(await result).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce();
  publish();
  expect(action).toHaveBeenCalledTimes(2);
  dialog.dispose();
});

test("live removal batches reject stale, forged and malformed selections and resolve every item", async () => {
  const dialog = setup();
  const removal = (id: string, group = "actor") => ({
    title: "Remove worktrees?",
    accept: "Approve all",
    removal: {
      group,
      item: { id, branch: id, path: `/trees/${id}`, changes: id === "two" ? "?? file\0" : "" },
    },
  });
  const first = dialog.request(removal("one"));
  const stale = await shown();
  expect(window().webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
    title: "Remove worktree?",
    accept: "Remove worktree",
    subject: "one",
  });
  answer(stale, ["one"]);
  expect(window().hide).not.toHaveBeenCalled();
  const second = dialog.request(removal("two"));
  const third = dialog.request(removal("three"));
  const foreign = dialog.request(removal("foreign", "other"));
  const id = await shown();
  expect(id).not.toBe(stale);
  const request = window().webContents.send.mock.calls.at(-1)?.[1];
  expect(request).toMatchObject({
    removals: [
      removal("one").removal.item,
      removal("two").removal.item,
      removal("three").removal.item,
    ],
  });
  expect(request).not.toHaveProperty("removalFeed");
  answer(stale, ["one"]);
  answer(id, true);
  answer(id, []);
  answer(id, [1]);
  answer(id, ["foreign"]);
  answer(id, ["one", "one"]);
  answer(id, ["one"], { sender: {}, senderFrame: window().webContents.mainFrame });
  expect(window().hide).not.toHaveBeenCalled();
  answer(id, ["one", "three"]);
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(false);
  await expect(third).resolves.toBe(true);
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalledTimes(2);
  });
  answer(await shown(), false);
  await expect(foreign).resolves.toBe(false);
  dialog.dispose();
});

test("abort cancels a batch even after new arrivals changed its confirmation ID", async () => {
  const dialog = setup();
  const abort = new AbortController();
  const request = (id: string) =>
    dialog.request(
      {
        title: "Remove?",
        accept: "Approve all",
        removal: { group: "actor", item: { id, branch: id, path: id, changes: "" } },
      },
      abort.signal,
    );
  const first = request("one");
  await shown();
  const second = request("two");
  const stale = await shown();
  abort.abort();
  answer(stale, ["one", "two"]);
  await expect(first).resolves.toBe(false);
  await expect(second).resolves.toBe(false);
  dialog.dispose();
});

test("a removal arriving after decline gets its own review before the old promise settles", async () => {
  const dialog = setup();
  const request = (id: string) =>
    dialog.request({
      title: "Remove?",
      accept: "Approve all",
      removal: { group: "actor", item: { id, branch: id, path: id, changes: "" } },
    });
  const first = request("one");
  answer(await shown(), false);
  const next = request("two");
  await expect(first).resolves.toBe(false);
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalledTimes(2);
  });
  answer(await shown(), true);
  await expect(next).resolves.toBe(true);
  dialog.dispose();
});

test("one aborted removal rotates the answer ID while peers stay under review", async () => {
  const dialog = setup();
  const abort = new AbortController();
  const request = (id: string, signal?: AbortSignal) =>
    dialog.request(
      {
        title: "Remove?",
        accept: "Approve all",
        removal: { group: "actor", item: { id, branch: id, path: id, changes: "" } },
      },
      signal,
    );
  const first = request("one", abort.signal);
  await shown();
  const second = request("two");
  const stale = await shown();
  abort.abort();
  await expect(first).resolves.toBe(false);
  const fresh = await shown();
  expect(fresh).not.toBe(stale);
  answer(stale, ["one", "two"]);
  expect(window().hide).not.toHaveBeenCalled();
  answer(fresh, true);
  await expect(second).resolves.toBe(true);
  dialog.dispose();
});

test("macOS blocks board input and native focus without a disabling sheet, then restores them", async () => {
  parent.isFocusable.mockReturnValue(false);
  const dialog = setup("darwin");
  const pending = dialog.request(content);
  const id = await shown();
  expect(parent.setEnabled).not.toHaveBeenCalled();
  expect(parent.setFocusable).toHaveBeenLastCalledWith(false);
  const event = { preventDefault: vi.fn() };
  parent.webContents.emit("before-input-event", event, { type: "keyUp" });
  parent.webContents.emit("before-mouse-event", event, { type: "mouseMove" });
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(window().setParentWindow).toHaveBeenCalledWith(parent);
  expect(window().moveTop).toHaveBeenCalledOnce();
  answer(id, false);
  expect(await pending).toBe(false);
  expect(parent.setEnabled).not.toHaveBeenCalled();
  expect(parent.setFocusable).toHaveBeenLastCalledWith(false);
  parent.webContents.emit("before-input-event", event, { type: "keyUp" });
  parent.webContents.emit("before-mouse-event", event, { type: "mouseMove" });
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  dialog.dispose();
});

for (const target of ["child", "parent"] as const) {
  for (const event of ["hide", "minimize", ...(target === "child" ? ["closed"] : [])]) {
    test(`${target} ${event} cancels safely and releases the scrim and board input`, async () => {
      const dialog = setup();
      const pending = dialog.request(content);
      await shown();
      const native = target === "child" ? window() : parent;
      if (event === "hide") native.isVisible.mockReturnValue(false);
      if (event === "minimize") native.isMinimized.mockReturnValue(true);
      native.emit(event);
      expect(await pending).toBe(false);
      expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
      expect(parent.setEnabled).not.toHaveBeenCalled();
      expect(parent.webContents.listenerCount("before-input-event")).toBe(0);
      dialog.dispose();
    });
  }
}

test.each(["isVisible", "isFocused"] as const)(
  "a failed %s reorders once, then cancels without leaving the board blocked",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dialog = setup();
    const result = dialog.request(content);
    await vi.advanceTimersByTimeAsync(0);
    window()[failure].mockReturnValue(false);
    window().show.mockImplementation(() => {
      parent.emit("focus");
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(window().show).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false);
    expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
    expect(parent.setEnabled).not.toHaveBeenCalled();
    dialog.dispose();
  },
);

test("a single native reorder can recover focus and leave the request available for human consent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup();
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  window().isFocused.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(window().show).toHaveBeenCalledTimes(2);
  window().isFocused.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(window().hide).not.toHaveBeenCalled();
  const request: unknown = window().webContents.send.mock.calls.at(-1)?.[1];
  if (!request || typeof request !== "object" || !("id" in request)) throw Error("Missing request");
  answer(request.id, true);
  expect(await pending).toBe(true);
  dialog.dispose();
  vi.useRealTimers();
});

test("a renderer that never measures its card cancels instead of stranding the scrim", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mock.autoSize = false;
  const dialog = setup();
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(false);
  expect(window().show).not.toHaveBeenCalled();
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
  dialog.dispose();
  vi.useRealTimers();
});

test("disposing a pending dialog after board destruction does not access its native webContents getter", async () => {
  const contents = parent.webContents;
  vi.spyOn(parent, "webContents", "get").mockImplementation(() => {
    if (parent.isDestroyed()) throw Error("Object has been destroyed");
    return contents;
  });
  const dialog = setup();
  const pending = dialog.request(content);
  await shown();
  parent.isDestroyed.mockReturnValue(true);
  dialog.dispose();
  expect(await pending).toBe(false);
  expect(contents.listenerCount("before-input-event")).toBe(0);
  expect(contents.listenerCount("before-mouse-event")).toBe(0);
});

test("late native hide/minimize notifications cannot cancel a visible reused child", async () => {
  const dialog = setup();
  const first = dialog.request(content);
  const old = await shown();
  answer(old, false);
  expect(await first).toBe(false);
  const next = dialog.request(content);
  await vi.waitFor(() => {
    expect(window().show).toHaveBeenCalledTimes(2);
  });
  const id = await shown();
  window().emit("hide");
  window().emit("minimize");
  parent.emit("hide");
  parent.emit("minimize");
  expect(window().hide).toHaveBeenCalledOnce();
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", true);
  answer(id, true);
  expect(await next).toBe(true);
  dialog.dispose();
});

test.each(["linux", "win32"] as const)("%s never steals app activation", async (platform) => {
  const dialog = setup(platform);
  const pending = dialog.request(content);
  const id = await shown();
  expect(mock.activate).not.toHaveBeenCalled();
  answer(id, false);
  expect(await pending).toBe(false);
  dialog.dispose();
});

test.each([true, false])(
  "macOS activation success=%s preserves the consent boundary",
  async (activates) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mock.autoSize = false;
    let active = false;
    const dialog = setup("darwin");
    window().isFocused.mockReturnValue(false);
    mock.activate.mockImplementation(() => {
      active = activates;
      if (active) parent.emit("focus");
    });
    window().focus.mockImplementation(() => {
      window().isFocused.mockReturnValue(active);
      if (active) window().emit("focus");
    });
    expect(mock.activate).not.toHaveBeenCalled();
    const pending = dialog.request(content, undefined, { activate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.activate).not.toHaveBeenCalled();
    resize({ width: 440, height: 240 });
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.activate).toHaveBeenCalledWith({ steal: true });
    expect(window().isFocused()).toBe(activates);
    await vi.advanceTimersByTimeAsync(2000);
    if (activates) {
      expect(window().hide).not.toHaveBeenCalled();
      expect(window().show).toHaveBeenCalledOnce();
      const request: unknown = window().webContents.send.mock.calls.at(-1)?.[1];
      if (!request || typeof request !== "object" || !("id" in request))
        throw Error("Missing request");
      answer(request.id, true);
      expect(await pending).toBe(true);
    } else {
      expect(await pending).toBe(false);
      expect(parent.setFocusable).toHaveBeenLastCalledWith(true);
      expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
    }
    mock.activate.mockClear();
    parent.emit("focus");
    expect(mock.activate).not.toHaveBeenCalled();
    dialog.dispose();
  },
);

test("macOS requests no person started never steal activation and still fail closed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mock.autoSize = false;
  const dialog = setup("darwin");
  window().isFocused.mockReturnValue(false);
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  resize({ width: 440, height: 240 });
  expect(mock.activate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toBe(false);
  expect(mock.activate).not.toHaveBeenCalled();
  dialog.dispose();
});

test("macOS occlusion reporting cannot dismiss a currently key child", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup("darwin");
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  window().isVisible.mockReturnValue(false);
  window().emit("hide");
  await vi.advanceTimersByTimeAsync(2000);
  expect(window().show).toHaveBeenCalledOnce();
  expect(window().hide).not.toHaveBeenCalled();
  const request: unknown = window().webContents.send.mock.calls.at(-1)?.[1];
  if (!request || typeof request !== "object" || !("id" in request)) throw Error("Missing request");
  answer(request.id, true);
  expect(await pending).toBe(true);
  dialog.dispose();
});

test("macOS hiding a child that lost key focus cancels and restores native board focusability", async () => {
  const dialog = setup("darwin");
  const pending = dialog.request(content);
  await shown();
  window().isVisible.mockReturnValue(false);
  window().isFocused.mockReturnValue(false);
  window().emit("hide");
  expect(await pending).toBe(false);
  expect(parent.setFocusable).toHaveBeenLastCalledWith(true);
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
  dialog.dispose();
});

test("macOS hide followed by native key loss cancels before recovery can show the child again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup("darwin");
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(100);
  window().isVisible.mockReturnValue(false);
  window().emit("hide");
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", true);
  // Cocoa may report key focus until the subsequent native blur notification.
  window().isFocused.mockReturnValue(false);
  window().emit("blur");
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
  expect(await pending).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(window().show).toHaveBeenCalledOnce();
  window().isVisible.mockReturnValue(true);
  window().isFocused.mockReturnValue(true);
  const next = dialog.request(content);
  await vi.advanceTimersByTimeAsync(100);
  const id = await shown();
  window().isFocused.mockReturnValue(false);
  window().emit("blur");
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", true);
  answer(id, false);
  expect(await next).toBe(false);
  dialog.dispose();
});

test("native occlusion events during reparent/show do not cancel the request being presented", async () => {
  const dialog = setup();
  window().show.mockImplementation(() => {
    window().isVisible.mockReturnValue(false);
    window().isFocused.mockReturnValue(false);
    parent.isVisible.mockReturnValue(false);
    window().emit("hide");
    parent.emit("hide");
    window().isVisible.mockReturnValue(true);
    window().isFocused.mockReturnValue(true);
    parent.isVisible.mockReturnValue(true);
  });
  const pending = dialog.request(content);
  const id = await shown();
  expect(window().hide).not.toHaveBeenCalled();
  answer(id, true);
  expect(await pending).toBe(true);
  dialog.dispose();
});

for (const platform of ["linux", "darwin"] as const) {
  for (const target of ["child", "parent"] as const) {
    for (const event of ["hide", "minimize"] as const) {
      test(`${platform} ${target} ${event} during presentation declines before enabling consent and permits reuse`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const dialog = setup(platform);
        const native = target === "child" ? window() : parent;
        window().webContents.focus.mockImplementationOnce(() => {
          if (event === "hide") native.isVisible.mockReturnValue(false);
          else native.isMinimized.mockReturnValue(true);
          window().isFocused.mockReturnValue(false);
          native.emit(event);
        });
        const pending = dialog.request(content);
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toBe(false);
        expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
        expect(parent.webContents.listenerCount("before-input-event")).toBe(0);
        expect(parent.webContents.listenerCount("before-mouse-event")).toBe(0);
        expect(window().webContents.send).not.toHaveBeenCalledWith(
          "confirmation:render",
          expect.objectContaining({ presented: true }),
        );
        await vi.advanceTimersByTimeAsync(6000);
        expect(window().show).toHaveBeenCalledOnce();
        window().isFocused.mockReturnValue(true);
        native.isVisible.mockReturnValue(true);
        native.isMinimized.mockReturnValue(false);
        const next = dialog.request(content);
        await vi.advanceTimersByTimeAsync(100);
        const id = await shown();
        answer(id, false);
        expect(await next).toBe(false);
        dialog.dispose();
      });
    }
  }
}

test.each(["win32", "linux"] as const)("%s preserves native enabled state", async (platform) => {
  const dialog = setup(platform);
  const result = dialog.request(content);
  const id = await shown();
  if (platform === "win32") expect(parent.setEnabled).toHaveBeenLastCalledWith(false);
  else expect(parent.setEnabled).not.toHaveBeenCalled();
  answer(id, false);
  expect(await result).toBe(false);
  if (platform === "win32") expect(parent.setEnabled).toHaveBeenLastCalledWith(true);
  dialog.dispose();
});

test.each([
  { x: -9000, y: 200, width: 440, height: 240 },
  { x: 190, y: 200, width: 0, height: 240 },
  { x: 190, y: 200, width: 440, height: 0 },
  { x: 190, y: 200, width: 1, height: 1 },
  { x: 1910, y: 1070, width: 440, height: 240 },
])("focused mapped geometry %j cannot approve", async (bounds) => {
  const dialog = setup();
  const result = dialog.request(content);
  const id = await shown();
  window().getBounds.mockReturnValue(bounds);
  answer(id, true);
  expect(await result).toBe(false);
  dialog.dispose();
});

test.each(["isFocused", "isVisible", "isMinimized"] as const)(
  "lost %s cannot authorize cleanup or a removal selection",
  async (state) => {
    const dialog = setup();
    const act = vi.fn();
    const pending = dialog.request({
      ...content,
      feed: {
        current: () => ({
          stage: "ready",
          progress: { total: 0, done: 0, phase: "fetch", stopped: false, items: [] },
        }),
        subscribe: () => () => {},
        act,
      },
    });
    const id = await shown();
    window()[state].mockReturnValue(state === "isMinimized");
    answer(id, true);
    expect(await pending).toBe(false);
    expect(act).not.toHaveBeenCalled();
    dialog.dispose();
  },
);

test("blocked board clicks and focus re-present instead of only focusing an invisible child", async () => {
  const dialog = setup();
  const result = dialog.request(content);
  const id = await shown();
  const preventDefault = vi.fn();
  parent.webContents.emit("before-mouse-event", { preventDefault }, { type: "mouseDown" });
  parent.webContents.emit("before-input-event", { preventDefault }, { type: "keyDown" });
  parent.emit("focus");
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(window().show).toHaveBeenCalledTimes(4);
  expect(window().moveTop).toHaveBeenCalledTimes(4);
  answer(id, false);
  expect(await result).toBe(false);
  dialog.dispose();
});

test("resume, unlock, display changes and parent show/restore repair presentation and dispose listeners", async () => {
  const dialog = setup();
  const result = dialog.request(content);
  const id = await shown();
  for (const event of ["resume", "unlock-screen"]) mock.power?.emit(event);
  for (const event of ["display-metrics-changed", "display-removed"]) mock.screen?.emit(event);
  for (const event of ["show", "restore"]) parent.emit(event);
  expect(window().show).toHaveBeenCalledTimes(7);
  answer(id, false);
  expect(await result).toBe(false);
  for (const event of ["resume", "unlock-screen"]) expect(mock.power?.listenerCount(event)).toBe(0);
  for (const event of ["display-metrics-changed", "display-removed"])
    expect(mock.screen?.listenerCount(event)).toBe(0);
  for (const event of ["show", "restore"]) expect(parent.listenerCount(event)).toBe(0);
  dialog.dispose();
});

test("silent geometry loss after the first successful check is repaired by the periodic guard", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup();
  const result = dialog.request(content);
  await vi.advanceTimersByTimeAsync(1000);
  window().bounds.x = -9000;
  await vi.advanceTimersByTimeAsync(5000);
  expect(window().show).toHaveBeenCalledTimes(2);
  expect(window().bounds.x).toBe(190);
  await vi.advanceTimersByTimeAsync(1000);
  dialog.dispose();
  expect(await result).toBe(false);
});

test("native presentation exceptions decline and release every input guard", async () => {
  const dialog = setup();
  window().show.mockImplementation(() => {
    throw Error("native failure");
  });
  expect(await dialog.request(content)).toBe(false);
  expect(parent.webContents.listenerCount("before-input-event")).toBe(0);
  expect(mock.power?.listenerCount("resume")).toBe(0);
  dialog.dispose();
});

test("sizes converge in the hidden viewport before presenting, and equal reports do not delay show", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mock.autoSize = false;
  const dialog = setup();
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  resize({ width: 548, height: 280 });
  expect(window().webContents.send).toHaveBeenLastCalledWith(
    "confirmation:render",
    expect.objectContaining({ presented: false }),
  );
  expect(window().getBounds()).toEqual({ x: 136, y: 180, width: 548, height: 280 });
  parent.emit("focus");
  await vi.advanceTimersByTimeAsync(60);
  resize({ width: 540, height: 240 });
  await vi.advanceTimersByTimeAsync(60);
  expect(window().show).not.toHaveBeenCalled();
  resize({ width: 540, height: 240 });
  await vi.advanceTimersByTimeAsync(40);
  expect(window().show).toHaveBeenCalledOnce();
  expect(window().getBounds()).toEqual({ x: 140, y: 200, width: 540, height: 240 });
  expect(window().webContents.send).toHaveBeenLastCalledWith(
    "confirmation:render",
    expect.objectContaining({ presented: true }),
  );
  resize({ width: 540, height: 240 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(window().show).toHaveBeenCalledOnce();
  dialog.dispose();
  expect(await pending).toBe(false);
});

test("cancellation clears a pending presentation and a native sizing error fails closed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dialog = setup();
  const controller = new AbortController();
  const pending = dialog.request(content, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(2000);
  expect(window().show).not.toHaveBeenCalled();
  expect(await pending).toBe(false);
  window().setBounds.mockImplementation(() => {
    throw Error("native failure");
  });
  const next = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  resize({ width: 500, height: 300 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await next).toBe(false);
  dialog.dispose();
});

test("unsettled consent is declined and layout churn cannot extend the one-second deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mock.autoSize = false;
  const dialog = setup();
  const early = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  resize({ width: 540, height: 280 });
  const request: unknown = window().webContents.send.mock.calls.at(-1)?.[1];
  if (!request || typeof request !== "object" || !("id" in request)) throw Error("Missing request");
  answer(request.id, true);
  expect(await early).toBe(false);
  const pending = dialog.request(content);
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 11; index++) {
    resize({ width: 540, height: 280 + index });
    await vi.advanceTimersByTimeAsync(90);
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(false);
  expect(window().show).not.toHaveBeenCalled();
  dialog.dispose();
});

test.each([true, false])(
  "deliberate dismissal restores native and web input focus (answer %s)",
  async (accepted) => {
    const dialog = setup();
    const pending = dialog.request(content);
    const id = await shown();
    parent.webContents.focus.mockImplementationOnce(() => {
      expect(parent.webContents.send).not.toHaveBeenCalledWith("confirmation:scrim", false);
    });
    answer(id, accepted);
    await expect(pending).resolves.toBe(accepted);
    expect(parent.focus).toHaveBeenCalledOnce();
    expect(parent.webContents.focus).toHaveBeenCalledOnce();
    dialog.dispose();
  },
);

test.each(["abort", "answer", "unavailable", "dispose"])(
  "%s after focus moves elsewhere never activates the board",
  async (reason) => {
    const dialog = setup();
    const controller = new AbortController();
    const pending = dialog.request(content, controller.signal);
    const id = await shown();
    window().isFocused.mockReturnValue(false);
    if (reason === "abort") controller.abort();
    else if (reason === "answer") answer(id, false);
    else if (reason === "unavailable") {
      window().isVisible.mockReturnValue(false);
      window().emit("hide");
    } else dialog.dispose();
    await expect(pending).resolves.toBe(false);
    expect(parent.focus).not.toHaveBeenCalled();
    expect(parent.webContents.focus).not.toHaveBeenCalled();
    dialog.dispose();
  },
);

test("availability rejection does not restore even if the child still reports key focus", async () => {
  const dialog = setup();
  const pending = dialog.request(content);
  await shown();
  parent.isMinimized.mockReturnValue(true);
  parent.emit("minimize");
  await expect(pending).resolves.toBe(false);
  expect(parent.focus).not.toHaveBeenCalled();
  expect(parent.webContents.focus).not.toHaveBeenCalled();
  dialog.dispose();
});

test("Windows releases native input and focuses web contents before dismissing the scrim", async () => {
  const dialog = setup("win32");
  const pending = dialog.request(content);
  const id = await shown();
  parent.webContents.send.mockImplementationOnce((channel: unknown, visible: unknown) => {
    expect(channel).toBe("confirmation:scrim");
    expect(visible).toBe(false);
    expect(parent.setEnabled).toHaveBeenLastCalledWith(true);
    expect(parent.webContents.focus).toHaveBeenCalledOnce();
  });
  answer(id, false);
  await expect(pending).resolves.toBe(false);
  expect(parent.webContents.send).toHaveBeenLastCalledWith("confirmation:scrim", false);
  dialog.dispose();
});
