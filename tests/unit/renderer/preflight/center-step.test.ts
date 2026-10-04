// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { centerStep } from "../../../../src/renderer/preflight/center-step";

afterEach(() => vi.unstubAllGlobals());

function fixture(scale = 1) {
  let resize = () => {};
  const disconnect = vi.fn();
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
  const media = { matches: false };
  vi.stubGlobal("matchMedia", () => media);
  const stage = document.createElement("main");
  const inner = document.createElement("div");
  const sizes = { stage: 1000, inner: 400, visualTop: 0 };
  Object.defineProperty(stage, "clientHeight", { get: () => sizes.stage });
  Object.defineProperty(inner, "offsetHeight", { get: () => sizes.inner });
  stage.getBoundingClientRect = () => new DOMRect(0, 0, 1000, sizes.stage * scale);
  inner.getBoundingClientRect = () =>
    new DOMRect(0, sizes.visualTop * scale, 1000, sizes.inner * scale);
  const animation = { cancel: vi.fn(), playState: "finished" };
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => animation);
  Object.defineProperty(inner, "animate", { value: animate });
  const dispose = centerStep(stage, inner);
  return {
    resize: () => {
      resize();
    },
    disconnect,
    media,
    stage,
    sizes,
    animation,
    animate,
    dispose,
  };
}

test("re-centers growth and shrinkage with a short animation and disposes it", () => {
  const f = fixture();
  f.resize();
  expect(f.animate).not.toHaveBeenCalled();
  f.sizes.inner = 600;
  f.resize();
  expect(f.animate).toHaveBeenLastCalledWith(
    [{ transform: "translateY(100px)" }, { transform: "translateY(0)" }],
    { duration: 180, easing: "ease-out" },
  );
  f.sizes.inner = 400;
  f.resize();
  expect(f.animate.mock.lastCall?.[0]).toEqual([
    { transform: "translateY(-100px)" },
    { transform: "translateY(0)" },
  ]);
  f.dispose();
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.animation.cancel).toHaveBeenCalledTimes(2);
});

test("continues interrupted growth from the visual position", () => {
  const f = fixture();
  f.sizes.inner = 600;
  f.resize();
  f.animation.playState = "running";
  f.sizes.inner = 700;
  f.sizes.visualTop = 180; // New margin 150 plus 30px of the unfinished move.
  f.resize();
  expect(f.animate.mock.lastCall?.[0]).toEqual([
    { transform: "translateY(80px)" },
    { transform: "translateY(0)" },
  ]);
  f.dispose();
});

test("overflow starts at the top immediately, without a transform creating more overflow", () => {
  const f = fixture();
  f.sizes.inner = 1200;
  f.resize();
  expect(f.animate).not.toHaveBeenCalled();
  f.sizes.inner = 400;
  f.resize();
  expect(f.animate).not.toHaveBeenCalled();
  f.dispose();
});

test("does not animate viewport changes, scrolled content, or reduced motion", () => {
  const f = fixture();
  f.sizes.stage = 800;
  f.resize();
  f.stage.scrollTop = 10;
  f.sizes.inner = 600;
  f.resize();
  f.stage.scrollTop = 0;
  f.media.matches = true;
  f.sizes.inner = 400;
  f.resize();
  expect(f.animate).not.toHaveBeenCalled();
  f.dispose();
  expect(f.disconnect).toHaveBeenCalledOnce();
});

test("content zoom keeps transition distances in local CSS pixels", () => {
  const f = fixture(1.25);
  f.sizes.inner = 600;
  f.resize();
  expect(f.animate.mock.lastCall?.[0]).toEqual([
    { transform: "translateY(100px)" },
    { transform: "translateY(0)" },
  ]);
  f.dispose();
});

test("growth near the stage height cannot animate the content bottom out of view", () => {
  const f = fixture();
  f.sizes.inner = 950;
  f.resize();
  expect(f.animate.mock.lastCall?.[0]).toEqual([
    { transform: "translateY(25px)" },
    { transform: "translateY(0)" },
  ]);
  f.dispose();
});
