// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { PreviewSnapshot } from "../../../../src/shared/previews";
import { attachPreviewComposition } from "../../../../src/renderer/board/preview-composition";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(root = true) {
  if (root) document.body.innerHTML = '<div id="root"></div>';
  const animations: Animation[] = [];
  const getAnimations = vi.fn(() => animations);
  Object.defineProperty(document, "getAnimations", { configurable: true, value: getAnimations });
  vi.stubGlobal(
    "KeyframeEffect",
    class {
      constructor(readonly target: Element) {}
    },
  );
  const bitmap = { width: 10, height: 20, close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => Promise.resolve(bitmap)),
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  let listener: ((snapshots: readonly PreviewSnapshot[]) => void) | undefined;
  const off = vi.fn();
  const cover = vi.fn(async (_value: boolean) => {});
  const dispose = attachPreviewComposition({
    pick: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    cover,
    onSnapshots: (callback) => {
      listener = callback;
      return off;
    },
  });
  const send = (snapshots: readonly PreviewSnapshot[]) => listener?.(snapshots);
  return { cover, dispose, off, send, bitmap, drawImage, animations, getAnimations };
}
const snapshot = {
  id: "a".repeat(32),
  image: "data:image/png;base64,AA==",
  bounds: { x: 2, y: 3, width: 40, height: 50, visible: true },
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test("freezes for panels, scrim, full drag and settings; preserves overlapping reasons and disposes", async () => {
  const f = fixture();
  expect(f.cover).toHaveBeenCalledWith(false);
  const root = document.getElementById("root");
  if (!root) throw new Error("root");
  for (const markup of [
    '<div class="row-menu"></div>',
    '<div class="board-confirmation-scrim"></div>',
    '<main class="board-home" data-dragging="true"></main>',
    '<main class="board-home" data-preview-covered="true"></main>',
  ]) {
    root.innerHTML = markup;
    await flush();
    expect(f.cover).toHaveBeenLastCalledWith(true);
    root.insertAdjacentHTML("beforeend", '<div class="wordmark-menu" aria-expanded="true"></div>');
    await flush();
    root.firstElementChild?.remove();
    await flush();
    expect(f.cover).toHaveBeenLastCalledWith(true);
    root.replaceChildren();
    await flush();
    expect(f.cover).toHaveBeenLastCalledWith(false);
  }
  expect(f.getAnimations).not.toHaveBeenCalled();
  f.send([snapshot]);
  await flush();
  expect(document.querySelector("canvas")?.style.left).toBe("2px");
  expect(f.drawImage).toHaveBeenCalled();
  expect(f.getAnimations).toHaveBeenCalled();
  f.send([snapshot]);
  await flush();
  expect(document.querySelectorAll("canvas")).toHaveLength(1);
  f.send([]);
  expect(document.querySelector("canvas")).toBeNull();
  f.send([snapshot]);
  f.dispose();
  await flush();
  expect(f.off).toHaveBeenCalled();
  expect(f.bitmap.close).toHaveBeenCalled();
  expect(document.querySelector("canvas")).toBeNull();
});
test("snapshots follow tile geometry and opacity during real animation lifetime", async () => {
  const f = fixture(false);
  document.body.innerHTML = `<section class="terminal-tile" data-preview-id="${snapshot.id}" style="opacity:0.4;padding:3px;border:2px solid black"><header class="tile-title"></header></section>`;
  const tile = document.querySelector("section");
  const title = document.querySelector("header");
  if (!tile || !title) throw new Error("tile");
  vi.spyOn(tile, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 0,
    width: 400,
    bottom: 300,
  } as DOMRect);
  vi.spyOn(title, "getBoundingClientRect").mockReturnValue({ bottom: 40 } as DOMRect);
  f.send([snapshot]);
  await flush();
  const image = document.querySelector("canvas");
  expect(image?.style.left).toBe("105px");
  expect(image?.style.width).toBe("390px");
  expect(image?.style.height).toBe("255px");
  expect(image?.style.opacity).toBe("0.4");
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  f.animations.push({
    effect: new KeyframeEffect(tile, []),
    playState: "running",
  } as unknown as Animation);
  tile.setAttribute("data-maximized", "true");
  await flush();
  expect(f.cover).toHaveBeenLastCalledWith(true);
  f.animations.splice(0);
  title.remove();
  tile.style.padding = "0px";
  tile.style.border = "none";
  frame?.(0);
  expect(image?.style.left).toBe("100px");
  expect(image?.style.height).toBe("300px");
  expect(f.cover).toHaveBeenLastCalledWith(false);
  f.dispose();
});
test("cover and bitmap failures leave board input available", async () => {
  const f = fixture();
  f.cover.mockRejectedValue(new Error("closed"));
  vi.mocked(createImageBitmap).mockRejectedValue(new Error("invalid"));
  document.getElementById("root")?.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
  f.send([snapshot]);
  await flush();
  f.dispose();
  await flush();
});
