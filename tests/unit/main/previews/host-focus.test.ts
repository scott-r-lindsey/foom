import { expect, test, vi } from "vitest";
import { fake, partition, fixture } from "./host-fixture";

test("only a human mouse-down permits focus, and navigation/reload detach before loading", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).not.toHaveBeenCalled();
  // A detached, loading view that takes focus gives it straight back.
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  wc.emit("did-finish-load");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  wc.emit("before-mouse-event", {}, { type: "mouseMove" });
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  wc.isFocused.mockReturnValue(true);
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.isFocused.mockReturnValue(false);
  // The human-focused preview is never asked to refocus itself.
  wc.emit("blur");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  expect(wc.focus).toHaveBeenCalledOnce();
  f.window.webContents.emit("focus");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(3);
  f.window.webContents.isDestroyed.mockReturnValue(true);
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(3);
  f.window.webContents.isDestroyed.mockReturnValue(false);
  const blocked = { url: "http://example.com", isMainFrame: true, preventDefault: vi.fn() };
  wc.emit("will-frame-navigate", blocked);
  wc.emit("will-redirect", blocked);
  expect(blocked.preventDefault).toHaveBeenCalledTimes(2);
  wc.emit("will-frame-navigate", {
    ...blocked,
    url: `foom-preview://${id}/a.md`,
    isMainFrame: false,
  });
  wc.emit("will-frame-navigate", { ...blocked, url: `foom-preview://${id}/a.md` });
  expect(f.window.contentView.removeChildView).toHaveBeenCalledOnce();
  wc.emit("did-start-navigation", {}, "", true, true);
  wc.emit("did-start-navigation", {}, "", false, false);
  wc.emit("did-start-loading");
  wc.emit("did-finish-load");
  expect(f.window.contentView.addChildView).toHaveBeenCalledTimes(2);
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  wc.emit("focus");
  await f.host.close(id);
});
test("reload and allowed main-frame navigation replace native contents but preserve the preview and partition", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  const bounds = { x: 10, y: 20, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  wc.emit("did-finish-load");
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  wc.emit("focus");
  const navigation = { url: wc.getURL(), isMainFrame: true, isSameDocument: false };
  wc.emit("did-start-navigation", { ...navigation, isSameDocument: true });
  wc.emit("did-start-navigation", { ...navigation, isMainFrame: false });
  wc.emit("did-start-navigation", { ...navigation, url: "https://example.com" });
  expect(wc.close).not.toHaveBeenCalled();
  wc.emit("did-start-navigation", navigation);
  const reloaded = fake.views[1];
  if (!reloaded) throw new Error("Missing reloaded view");
  expect(wc.close).toHaveBeenCalledOnce();
  expect(f.window.webContents.focus).not.toHaveBeenCalled();
  expect(reloaded.webContents.focus).not.toHaveBeenCalled();
  expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(reloaded.options).toEqual(view.options);
  expect(reloaded.webContents.loadURL).toHaveBeenCalledWith(navigation.url);
  expect(partition.protocol.handle).toHaveBeenCalledOnce();
  expect(partition.clearStorageData).not.toHaveBeenCalled();
  reloaded.webContents.emit("did-finish-load");
  expect(reloaded.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 100, height: 100 });
  expect(f.window.contentView.addChildView).toHaveBeenLastCalledWith(reloaded);
  reloaded.webContents.emit("focus");
  expect(reloaded.webContents.focus).toHaveBeenCalledOnce();
  expect(f.window.webContents.focus).not.toHaveBeenCalled();
  f.window.webContents.emit("focus");
  vi.useFakeTimers();
  const markdown = `foom-preview://${id}/b.md`;
  reloaded.webContents.emit("did-start-navigation", { ...navigation, url: markdown });
  expect(fake.views).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(250);
  const linked = fake.views[2];
  expect(linked?.webContents.loadURL).toHaveBeenCalledWith(markdown);
  linked?.webContents.emit("did-finish-load");
  linked?.webContents.emit("focus");
  expect(linked?.webContents.focus).not.toHaveBeenCalled();
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  expect(f.registry.records.get(id)?.relativePath).toBe("a.html");
  await f.host.dispose(false);
});
test("focus handoff waits for attachment and yields to a later user focus change", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  // Native close can focus the board synchronously; that is not a human change.
  view.webContents.close.mockImplementation(() => {
    view.webContents.isDestroyed.mockReturnValue(true);
    f.window.webContents.emit("focus");
  });
  view.webContents.emit("did-start-navigation", {
    url: `foom-preview://${id}/b.md`,
    isMainFrame: true,
    isSameDocument: false,
  });
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  replacement.webContents.emit("did-finish-load");
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});
test("hiding a loading replacement cancels its focus handoff", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  f.host.bounds(id, { ...bounds, visible: false });
  replacement.webContents.emit("did-finish-load");
  f.host.bounds(id, bounds);
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  replacement.webContents.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});
test("unsolicited focus returns to the board while a focused replacement is pending", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const other = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[2];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-finish-load");
  replacement.webContents.emit("did-start-navigation", navigation);
  other.view.webContents.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  // Hiding during the delay must also discard focus intent before re-showing.
  f.host.bounds(id, { ...bounds, visible: false });
  f.host.bounds(id, bounds);
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[3];
  delayed?.webContents.emit("did-finish-load");
  expect(delayed?.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});
test("handoff blocks board keys before detach through throttle and load, and disposes listeners", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  const event = { preventDefault: vi.fn() };
  const key = () => f.window.webContents.emit("before-input-event", event);
  key();
  expect(event.preventDefault).not.toHaveBeenCalled();
  view.webContents.emit("will-frame-navigate", {
    url: `foom-preview://${id}/b.md`,
    isMainFrame: true,
  });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  f.window.webContents.emit("focus");
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-finish-load");
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
  replacement.webContents.emit("focus");
  event.preventDefault.mockClear();
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(0);
  expect(replacement.webContents.focus).toHaveBeenCalledOnce();
  replacement.webContents.emit("did-start-navigation", navigation);
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[2];
  if (!delayed) throw new Error("Missing delayed replacement");
  delayed.webContents.emit("did-finish-load");
  expect(delayed.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
  expect(f.window.webContents.listenerCount("before-input-event")).toBe(0);
  expect(f.window.webContents.listenerCount("before-mouse-event")).toBe(0);
});
test("hiding or closing a pending handoff unblocks board input", async () => {
  for (const action of ["hide", "close"] as const) {
    const f = await fixture();
    const { id, view } = await f.open();
    const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
    f.host.bounds(id, bounds);
    view.webContents.emit("did-finish-load");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    view.webContents.emit("focus");
    view.webContents.emit("did-start-navigation", {
      url: view.webContents.getURL(),
      isMainFrame: true,
      isSameDocument: false,
    });
    const event = { preventDefault: vi.fn() };
    f.window.webContents.emit("before-input-event", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (action === "hide") {
      f.host.bounds(id, { ...bounds, visible: false });
      await Promise.resolve();
    } else await f.host.close(id);
    f.window.webContents.emit("before-input-event", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await f.host.dispose(false);
  }
});
test("a failed replacement load cancels the input gate", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  fake.nextLoad = Promise.reject(new Error("Load failed"));
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await Promise.resolve();
  await Promise.resolve();
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});
test("rapid reloads stop the old script, bound recreation and cancel pending work on close", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-start-navigation", navigation);
  expect(replacement.webContents.close).toHaveBeenCalledOnce();
  for (let i = 0; i < 10; i++) replacement.webContents.emit("did-start-navigation", navigation);
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  await vi.advanceTimersByTimeAsync(249);
  expect(fake.views).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.views).toHaveLength(3);
  fake.views[2]?.webContents.emit("did-start-navigation", navigation);
  await f.host.close(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.views).toHaveLength(3);
  await f.host.dispose(false);
});
test("every preview forwards native input to the board dispatcher without taking focus", async () => {
  const f = await fixture();
  const { view } = await f.open();
  const handler = vi.fn();
  f.window.webContents.on("before-input-event", handler);
  const event = { preventDefault: vi.fn() };
  const input = { type: "keyDown", key: "B", control: true, shift: true };
  view.webContents.emit("before-input-event", event, input);
  expect(handler).toHaveBeenCalledWith(event, input);
  expect(view.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});

test.each(["Escape", "blur", "deadline"] as const)(
  "%s releases a stuck handoff only after blurring terminal DOM focus and revokes late focus",
  async (reason) => {
    vi.useFakeTimers();
    const f = await fixture();
    const { id, view } = await f.open();
    f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
    view.webContents.emit("did-finish-load");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
    view.webContents.emit("did-start-navigation", navigation);
    const replacement = fake.views[1];
    if (!replacement) throw new Error("Missing replacement");
    f.window.isFocused.mockReturnValue(reason !== "blur");
    // A load can finish without the OS granting focus; it must still time out.
    if (reason === "deadline") replacement.webContents.emit("did-finish-load");
    let blurred = () => {};
    f.window.webContents.executeJavaScript.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        blurred = resolve;
      }),
    );
    const event = { preventDefault: vi.fn() };
    if (reason === "Escape")
      replacement.webContents.emit("before-input-event", event, { key: "Escape" });
    else if (reason === "blur") f.window.emit("blur");
    else {
      await vi.advanceTimersByTimeAsync(1499);
      expect(f.window.webContents.executeJavaScript).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f.window.webContents.executeJavaScript).toHaveBeenCalledOnce();
    expect(f.window.webContents.executeJavaScript).toHaveBeenCalledWith(
      'if (document.activeElement?.closest(".xterm")) document.activeElement.blur()',
    );
    event.preventDefault.mockClear();
    f.window.webContents.emit("before-input-event", event, { key: "x" });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    blurred();
    await Promise.resolve();
    event.preventDefault.mockClear();
    f.window.webContents.emit("before-input-event", event, { key: "x" });
    expect(event.preventDefault).not.toHaveBeenCalled();
    replacement.webContents.focus.mockClear();
    replacement.webContents.emit("did-finish-load");
    replacement.webContents.emit("focus");
    expect(replacement.webContents.focus).not.toHaveBeenCalled();
    expect(f.window.webContents.focus).toHaveBeenCalledTimes(reason === "blur" ? 1 : 2);
    await f.host.dispose(false);
    expect(f.window.listenerCount("blur")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a cancelled handoff cannot be revived by a delayed replacement or stale blur completion", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-start-navigation", navigation);
  let blurred = () => {};
  f.window.webContents.executeJavaScript.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      blurred = resolve;
    }),
  );
  f.window.emit("blur");
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[2];
  if (!delayed) throw new Error("Missing delayed replacement");
  delayed.webContents.emit("did-finish-load");
  expect(delayed.webContents.focus).not.toHaveBeenCalled();
  delayed.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  delayed.webContents.emit("did-start-navigation", navigation);
  blurred();
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await f.host.dispose(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.getTimerCount()).toBe(0);
});

test("blur failure keeps PTY input gated and Escape can retry", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  f.window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Board unavailable"));
  f.window.emit("blur");
  await Promise.resolve();
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event, { key: "x" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.window.webContents.isDestroyed.mockReturnValue(true);
  f.window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Destroyed"));
  f.window.webContents.emit("before-input-event", event, { key: "Escape" });
  await Promise.resolve();
  await Promise.resolve();
  event.preventDefault.mockClear();
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).not.toHaveBeenCalled();
});
