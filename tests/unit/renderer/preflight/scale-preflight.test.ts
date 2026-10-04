// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { scalePreflight } from "../../../../src/renderer/preflight/scale-preflight";

afterEach(() => vi.unstubAllGlobals());

function fixture(width = 1560, height = 1260) {
  let resize = () => {};
  let mutate = () => {};
  let paint = () => {};
  const disconnect = vi.fn();
  const unwatch = vi.fn();
  const request = vi.fn((callback: () => void) => {
    paint = callback;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect = unwatch;
    },
  );
  const fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const viewport = document.createElement("main");
  const content = document.createElement("div");
  const stage = document.createElement("div");
  const inner = document.createElement("div");
  const size = { width, height, body: 600, bodyWidth: 900, footer: 64 };
  const scale = () => Number(content.style.zoom);
  Object.defineProperty(viewport, "clientWidth", { get: () => size.width });
  Object.defineProperty(viewport, "clientHeight", { get: () => size.height });
  Object.defineProperty(stage, "clientHeight", { get: () => size.height / scale() - size.footer });
  Object.defineProperty(stage, "clientWidth", { get: () => size.width / scale() });
  Object.defineProperty(inner, "offsetHeight", { get: () => size.body });
  Object.defineProperty(inner, "scrollHeight", { get: () => size.body });
  Object.defineProperty(inner, "scrollWidth", { get: () => size.bodyWidth });
  const dispose = scalePreflight(viewport, content, stage, inner);
  return {
    size,
    stage,
    fonts,
    scale,
    dispose,
    disconnect,
    unwatch,
    request,
    cancel,
    resize: () => {
      resize();
    },
    mutate: () => {
      mutate();
    },
    paint: () => {
      paint();
    },
  };
}

test("fits actual content plus the footer and responds to viewport dimensions", () => {
  const f = fixture();
  expect(f.scale()).toBe(1.5);
  f.size.width = 1040;
  f.resize();
  f.paint();
  expect(f.scale()).toBe(1);
  f.size.width = 2080;
  f.size.body = 900;
  f.resize();
  f.paint();
  expect(f.scale()).toBeLessThanOrEqual(1261 / 964);
  expect(f.scale()).toBeGreaterThan(1.3);
  f.dispose();
});

test("a larger step lowers the shared ceiling; shorter steps and shrinking results do not grow it", () => {
  const f = fixture();
  f.size.body = 1000;
  f.mutate();
  f.paint();
  const fitted = f.scale();
  expect(fitted).toBeGreaterThan(1);
  expect(fitted).toBeLessThan(1.2);
  f.size.body = 200;
  f.mutate();
  f.paint();
  expect(f.scale()).toBe(fitted);
  f.size.height = 1400;
  f.resize();
  f.paint();
  expect(f.scale()).toBe(1.5);
  f.dispose();
});

test("horizontal overflow also limits enlargement", () => {
  const f = fixture();
  f.size.bodyWidth = 1300;
  f.mutate();
  f.paint();
  expect(f.scale()).toBeGreaterThan(1.19);
  expect(f.scale()).toBeLessThan(1.21);
  f.dispose();
});

test("unbounded content scrolls at base size and preserves the user's scroll position", () => {
  const f = fixture();
  f.stage.scrollTop = 250;
  f.size.body = 10000;
  f.mutate();
  f.paint();
  expect(f.scale()).toBe(1);
  expect(f.stage.scrollTop).toBe(250);
  f.dispose();
});

test("small and hidden slots never shrink controls; large displays stay bounded", () => {
  const f = fixture(400, 300);
  expect(f.scale()).toBe(1);
  f.size.width = 0;
  f.resize();
  f.paint();
  expect(f.scale()).toBe(1);
  f.size.width = 400;
  f.size.height = 0;
  f.resize();
  f.paint();
  expect(f.scale()).toBe(1);
  f.size.width = 5000;
  f.size.height = 4000;
  f.resize();
  f.paint();
  expect(f.scale()).toBe(2);
  f.dispose();
});

test("coalesces streaming, font and resize updates and cleans up pending work", () => {
  const f = fixture();
  f.resize();
  f.mutate();
  f.fonts.dispatchEvent(new Event("loadingdone"));
  expect(f.request).toHaveBeenCalledOnce();
  f.paint();
  f.resize();
  f.dispose();
  expect(f.cancel).toHaveBeenCalledWith(1);
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.unwatch).toHaveBeenCalledOnce();
  f.fonts.dispatchEvent(new Event("loadingdone"));
  expect(f.request).toHaveBeenCalledTimes(2);
});
