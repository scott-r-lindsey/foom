import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ITerminalAddon } from "@xterm/xterm";
import { createWebglRenderer } from "../../../../src/renderer/terminal/webgl-renderer";

const mock = vi.hoisted(() => {
  const addons: {
    lose: () => void;
    dispose: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  }[] = [];
  return { constructorFails: false, addons };
});
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    private callback: (() => void) | undefined;
    dispose = vi.fn();
    off = vi.fn(() => {
      this.callback = undefined;
    });
    constructor() {
      if (mock.constructorFails) throw new Error("WebGL unavailable");
      mock.addons.push(this);
    }
    onContextLoss(callback: () => void) {
      this.callback = callback;
      return { dispose: this.off };
    }
    lose = () => {
      this.callback?.();
    };
  },
}));
const views: ReturnType<typeof createWebglRenderer>[] = [];
const view = () => {
  const loadAddon = vi.fn<(addon: ITerminalAddon) => void>();
  const fallback = vi.fn();
  const renderer = createWebglRenderer({ loadAddon }, fallback);
  views.push(renderer);
  return { renderer, loadAddon, fallback };
};
beforeEach(() => {
  mock.addons.length = 0;
  mock.constructorFails = false;
});
afterEach(() => {
  for (const renderer of views.splice(0)) renderer.dispose();
});

test("visible views load once, hidden views release resources, unmount is final and idempotent", () => {
  const { renderer, loadAddon, fallback } = view();
  renderer.visible(false);
  expect(loadAddon).not.toHaveBeenCalled();
  renderer.visible(true);
  renderer.visible(true);
  expect(loadAddon).toHaveBeenCalledTimes(1);
  const first = mock.addons[0];
  expect(first).toBeDefined();
  renderer.visible(false);
  expect(first?.dispose).toHaveBeenCalledExactlyOnceWith();
  expect(first?.off).toHaveBeenCalledOnce();
  renderer.visible(true);
  expect(loadAddon).toHaveBeenCalledTimes(2);
  renderer.dispose();
  renderer.dispose();
  renderer.visible(true);
  renderer.visible(false);
  expect(mock.addons[1]?.dispose).toHaveBeenCalledOnce();
  expect(loadAddon).toHaveBeenCalledTimes(2);
  expect(fallback).not.toHaveBeenCalled();
});

test("twelve visible contexts leave overflow on DOM until another attachment can claim a slot", () => {
  const terminals = Array.from({ length: 13 }, view);
  for (const { renderer } of terminals) renderer.visible(true);
  expect(mock.addons).toHaveLength(12);
  expect(terminals[12]?.loadAddon).not.toHaveBeenCalled();
  terminals[0]?.renderer.visible(false);
  terminals[12]?.renderer.visible(true);
  expect(terminals[12]?.loadAddon).toHaveBeenCalledOnce();
  expect(mock.addons).toHaveLength(13);
});

test("context loss disposes the addon and listener, refits DOM and never recreates the terminal", () => {
  const { renderer, loadAddon, fallback } = view();
  renderer.visible(true);
  mock.addons[0]?.lose();
  expect(mock.addons[0]?.dispose).toHaveBeenCalledOnce();
  expect(mock.addons[0]?.off).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledOnce();
  mock.addons[0]?.lose();
  renderer.visible(false);
  renderer.visible(true);
  renderer.dispose();
  expect(loadAddon).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledOnce();
  expect(mock.addons[0]?.dispose).toHaveBeenCalledOnce();
});

test("constructor failures retain DOM without consuming a context or retrying", () => {
  const { renderer, loadAddon, fallback } = view();
  mock.constructorFails = true;
  renderer.visible(true);
  mock.constructorFails = false;
  renderer.visible(false);
  renderer.visible(true);
  expect(loadAddon).not.toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledOnce();
  const terminals = Array.from({ length: 12 }, view);
  for (const { renderer: other } of terminals) other.visible(true);
  expect(mock.addons).toHaveLength(12);
});

test("activation failure cleans the partial addon and returns its budget slot", () => {
  const { renderer, loadAddon, fallback } = view();
  loadAddon.mockImplementation(() => {
    throw new Error("context initialization failed");
  });
  renderer.visible(true);
  expect(mock.addons[0]?.dispose).toHaveBeenCalledOnce();
  expect(mock.addons[0]?.off).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledOnce();
  renderer.visible(true);
  expect(loadAddon).toHaveBeenCalledOnce();
  for (const other of Array.from({ length: 12 }, view)) other.renderer.visible(true);
  expect(mock.addons).toHaveLength(13);
});
