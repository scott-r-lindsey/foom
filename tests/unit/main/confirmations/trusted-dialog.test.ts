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
  screen: { getDisplayMatching: () => ({ workArea: mock.workArea }) },
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
  webContents: Object.assign(new EventEmitter(), { send: vi.fn(), getZoomFactor: vi.fn(() => 1) }),
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
  parent.webContents.emit("before-input-event", event);
  parent.webContents.emit("before-mouse-event", event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(window().setParentWindow).toHaveBeenCalledWith(parent);
  expect(window().moveTop).toHaveBeenCalledOnce();
  answer(id, false);
  expect(await pending).toBe(false);
  expect(parent.setEnabled).not.toHaveBeenCalled();
  expect(parent.setFocusable).toHaveBeenLastCalledWith(false);
  parent.webContents.emit("before-input-event", event);
  parent.webContents.emit("before-mouse-event", event);
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
      expect(parent.setEnabled).toHaveBeenLastCalledWith(true);
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
    expect(parent.setEnabled).toHaveBeenLastCalledWith(true);
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
    const pending = dialog.request(content);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.activate).not.toHaveBeenCalled();
    resize({ width: 440, height: 240 });
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
