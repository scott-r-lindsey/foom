// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PreviewSnapshot } from "../../../../src/shared/previews";
import { attachPreviewComposition } from "../../../../src/renderer/board/preview-composition";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  frames.clear();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
const frame = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};
const settle = async () => {
  await flush();
  frame();
  await flush();
};
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
  const painted = vi.fn(async () => {});
  const cover = vi.fn(async (_value: boolean) => {});
  const dispose = attachPreviewComposition({
    reload: vi.fn(async () => {}),
    popout: vi.fn(),
    pick: vi.fn(),
    network: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    painted,
    cover,
    onSnapshots: (callback) => {
      listener = callback;
      return off;
    },
  });
  const send = (snapshots: readonly PreviewSnapshot[]) => listener?.(snapshots);
  return { painted, cover, dispose, off, send, bitmap, drawImage, animations, getAnimations };
}
const snapshot = {
  id: "a".repeat(32),
  image: "data:image/png;base64,AA==",
  version: 1,
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
    await settle();
    expect(f.cover).toHaveBeenLastCalledWith(true);
    root.insertAdjacentHTML("beforeend", '<div class="wordmark-menu" aria-expanded="true"></div>');
    await settle();
    root.firstElementChild?.remove();
    await settle();
    expect(f.cover).toHaveBeenLastCalledWith(true);
    root.replaceChildren();
    await settle();
    expect(f.cover).toHaveBeenLastCalledWith(false);
  }
  expect(f.getAnimations).not.toHaveBeenCalled();
  f.send([snapshot]);
  await settle();
  expect(document.querySelector("canvas")?.style.left).toBe("2px");
  expect(f.drawImage).toHaveBeenCalled();
  expect(f.getAnimations).toHaveBeenCalled();
  f.send([snapshot]);
  await settle();
  expect(document.querySelectorAll("canvas")).toHaveLength(1);
  f.send([]);
  expect(document.querySelector("canvas")).toBeNull();
  f.send([snapshot]);
  f.dispose();
  await settle();
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
  await settle();
  const image = document.querySelector("canvas");
  expect(image?.style.left).toBe("105px");
  expect(image?.style.width).toBe("390px");
  expect(image?.style.height).toBe("255px");
  expect(image?.style.opacity).toBe("0.4");
  f.animations.push({
    effect: new KeyframeEffect(tile, []),
    playState: "running",
  } as unknown as Animation);
  tile.setAttribute("data-maximized", "true");
  await settle();
  expect(f.cover).toHaveBeenLastCalledWith(false);
  f.animations.splice(0);
  title.remove();
  tile.style.padding = "0px";
  tile.style.border = "none";
  frame();
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
  await settle();
  f.dispose();
  await settle();
});

test("paint acknowledgement waits for decode and a painted frame, rejects stale decodes and disposal", async () => {
  const f = fixture();
  let resolve: ((bitmap: ImageBitmap) => void) | undefined;
  vi.mocked(createImageBitmap).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.send([snapshot]);
  f.send([snapshot]);
  frame();
  frame();
  expect(f.painted).not.toHaveBeenCalled();
  resolve?.(f.bitmap);
  await flush();
  frame();
  expect(f.painted).not.toHaveBeenCalled();
  frame();
  expect(f.painted).toHaveBeenCalledExactlyOnceWith(snapshot.id, 1);
  f.send([snapshot]);
  frame();
  frame();
  expect(f.painted).toHaveBeenCalledTimes(2);
  f.send([{ ...snapshot, version: 2 }]);
  f.send([{ ...snapshot, version: 3 }]);
  await flush();
  frame();
  frame();
  expect(f.painted).toHaveBeenLastCalledWith(snapshot.id, 3);
  expect(f.painted).not.toHaveBeenCalledWith(snapshot.id, 2);
  f.send([snapshot]);
  await flush();
  f.dispose();
  frame();
  frame();
  expect(f.painted).toHaveBeenCalledTimes(3);
});
test("a missing canvas context cannot acknowledge unpainted pixels", async () => {
  const f = fixture();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  f.send([snapshot]);
  await flush();
  expect(f.painted).not.toHaveBeenCalled();
  expect(f.bitmap.close).toHaveBeenCalled();
  f.dispose();
});

test("a failed replacement canvas context preserves the previously drawn cache", async () => {
  const f = fixture();
  f.send([snapshot]);
  await flush();
  const canvas = document.querySelector("canvas");
  expect(canvas?.width).toBe(10);
  f.bitmap.width = 99;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  f.send([{ ...snapshot, version: 2 }]);
  await flush();
  expect(canvas?.width).toBe(10);
  expect(f.drawImage).toHaveBeenCalledTimes(1);
  f.dispose();
});

test.each([false, true])(
  "terminal repaint bursts do no composition work (previews: %s)",
  async (previews) => {
    const f = fixture();
    document.getElementById("root")?.insertAdjacentHTML(
      "beforeend",
      `
    <section class="terminal-tile"><div class="tile-terminal"><div class="xterm"><div class="xterm-rows"><div>old</div></div></div></div></section>
    ${previews ? `<section class="terminal-tile" data-preview-id="${snapshot.id}"><header class="tile-title"></header></section>` : ""}
  `,
    );
    if (previews) f.send([snapshot]);
    await settle();
    await settle();
    const rows = document.querySelector(".xterm-rows");
    if (!rows) throw new Error("rows");
    const queries = vi.spyOn(document, "querySelector");
    const layout = vi.spyOn(Element.prototype, "getBoundingClientRect");
    f.getAnimations.mockClear();
    for (let index = 0; index < 100; index++) {
      const removed = rows.firstElementChild;
      rows.replaceChildren(document.createElement("div"));
      removed?.setAttribute("style", "height:1px");
      rows.firstElementChild?.setAttribute("style", `height:${String(index)}px`);
      await flush();
    }
    console.info("terminal repaint composition", {
      previews,
      queries: queries.mock.calls.length,
      layouts: layout.mock.calls.length,
      animations: f.getAnimations.mock.calls.length,
    });
    expect(queries).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    frame();
    expect(queries).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(f.getAnimations).not.toHaveBeenCalled();
    f.dispose();
  },
);

test("board mutations and snapshots share one frame, follow animations and cancel pending disposal", async () => {
  const f = fixture();
  const root = document.getElementById("root");
  if (!root) throw new Error("root");
  root.innerHTML = `<main class="board-home"><section class="terminal-tile" data-preview-id="${snapshot.id}"><header class="tile-title"></header></section></main>`;
  f.send([snapshot]);
  await settle();
  await settle();
  const tile = root.querySelector("section");
  const board = root.querySelector("main");
  if (!tile || !board) throw new Error("board");
  const layout = vi.spyOn(tile, "getBoundingClientRect");
  const queries = vi.spyOn(document, "querySelector");
  f.getAnimations.mockClear();
  for (let index = 0; index < 100; index++) {
    tile.style.left = `${String(index)}px`;
    tile.dataset["maximized"] = "true";
    tile.dataset["behind"] = "true";
    await flush();
  }
  board.dataset["previewCovered"] = "true";
  root.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
  f.send([snapshot]);
  await flush();
  expect(layout).not.toHaveBeenCalled();
  expect(queries).not.toHaveBeenCalled();
  expect(f.getAnimations).not.toHaveBeenCalled();
  frame();
  expect(layout).toHaveBeenCalledTimes(1);
  expect(f.getAnimations).toHaveBeenCalledTimes(1);
  expect(f.cover).toHaveBeenLastCalledWith(true);
  await flush();
  frame();
  expect(layout).toHaveBeenCalledTimes(1);

  const animation = {
    effect: new KeyframeEffect(tile, []),
    playState: "running",
  } as unknown as Animation;
  f.animations.push(animation);
  tile.style.left = "0px";
  await settle();
  expect(layout).toHaveBeenCalledTimes(2);
  // Mutation and animation work must use the same pending frame.
  root.querySelector("dialog")?.remove();
  board.dataset["previewCovered"] = "false";
  await flush();
  frame();
  expect(layout).toHaveBeenCalledTimes(3);
  expect(f.cover).toHaveBeenLastCalledWith(false);
  f.animations.splice(0);
  frame();
  expect(layout).toHaveBeenCalledTimes(4);
  frame();
  expect(layout).toHaveBeenCalledTimes(4);
  board.dataset["dragging"] = "true";
  await flush();
  f.dispose();
  frame();
  expect(layout).toHaveBeenCalledTimes(4);
  expect(f.cover).toHaveBeenLastCalledWith(false);
});
