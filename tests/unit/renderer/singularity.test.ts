// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createSingularity } from "../../../src/renderer/ui/singularity";
import { canvasContext } from "./flight-canvas-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const images: HTMLImageElement[] = [];
  vi.stubGlobal("Image", function ImageFixture() {
    const image = document.createElement("img");
    images.push(image);
    return image;
  });
  const gl = {
    createShader: vi.fn<() => WebGLShader | null>(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    useProgram: vi.fn(),
    createBuffer: vi.fn<() => WebGLBuffer | null>(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    uniform1i: vi.fn(),
    getUniformLocation: vi.fn((_program: unknown, name: string) => name),
    viewport: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
    isContextLost: vi.fn(() => false),
    deleteTexture: vi.fn(),
    deleteShader: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
    getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
  };
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => gl as unknown as WebGLRenderingContext);
  const repaint = vi.fn();
  const load = () => {
    for (const image of images) image.dispatchEvent(new Event("load"));
  };
  return { gl, images, context, repaint, load };
}
test("loads only local baked assets; GPU draw scales with the surface and resources are released", () => {
  const { gl, images, repaint, load } = fixture();
  const view = createSingularity(repaint);
  expect(images.map((i) => i.getAttribute("src"))).toEqual([
    "art/singularity.png",
    "art/lens.png",
    "art/emission.png",
    "art/sky.png",
  ]);
  load();
  expect(repaint).toHaveBeenCalledTimes(4);
  const { ctx, draw } = canvasContext();
  view.draw(ctx, 2000, 1000, 1200, 400, 80, 4000, true);
  expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 1440, 720);
  expect(gl.uniform1f).toHaveBeenCalledWith("time", 4);
  view.draw(ctx, 2000, 1000, 1200, 400, 80, 4000, false);
  expect(gl.uniform1f).toHaveBeenCalledWith("dark", 0);
  gl.isContextLost.mockReturnValue(true);
  view.draw(ctx, 500, 300, 250, 150, 30, 0, true);
  gl.isContextLost.mockReturnValue(false);
  const surface: unknown = draw.drawImage.mock.calls[0]?.[0];
  expect(surface).toBeInstanceOf(HTMLCanvasElement);
  if (!(surface instanceof HTMLCanvasElement)) throw new Error("Missing surface");
  const lost = new Event("webglcontextlost", { cancelable: true });
  surface.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true);
  view.draw(ctx, 500, 300, 250, 150, 30, 0, true);
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  const pending = images[1];
  const lateLoad = pending?.onload;
  const lateStill = images[0]?.onload;
  view.dispose();
  if (!pending || !lateLoad || !lateStill) throw new Error("Missing load callback");
  lateLoad.call(pending, new Event("load"));
  lateStill.call(pending, new Event("load"));
  expect(gl.deleteTexture).toHaveBeenCalledTimes(3);
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(gl.deleteBuffer).toHaveBeenCalledOnce();
  expect(gl.deleteProgram).toHaveBeenCalledOnce();
  const paints = repaint.mock.calls.length;
  load();
  expect(repaint).toHaveBeenCalledTimes(paints);
  view.draw(ctx, 500, 300, 250, 150, 30, 0, true);
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
});
test("without WebGL, renders the baked still and keeps an opaque shadow while it loads", () => {
  const { context, images, load, repaint } = fixture();
  context.mockReturnValue(null);
  const view = createSingularity(repaint);
  const { ctx, draw } = canvasContext();
  view.draw(ctx, 500, 300, 250, 150, 30, 0, true);
  expect(draw.arc).toHaveBeenCalledWith(250, 150, 30, 0, Math.PI * 2);
  const still = images[0];
  Object.defineProperties(still, { complete: { value: true }, naturalWidth: { value: 512 } });
  load();
  view.draw(ctx, 500, 300, 250, 150, 30, 0, true);
  expect(draw.drawImage).toHaveBeenCalledWith(
    still,
    expect.any(Number),
    expect.any(Number),
    expect.closeTo(161.658, 2),
    expect.closeTo(161.658, 2),
  );
  view.dispose();
});
for (const failure of [
  "createShader",
  "getShaderParameter",
  "getProgramParameter",
  "createBuffer",
] as const) {
  test(`GPU ${failure} failure retains the fallback`, () => {
    const { gl, load, repaint } = fixture();
    if (failure === "getShaderParameter" || failure === "getProgramParameter")
      gl[failure].mockReturnValue(false);
    else gl[failure].mockReturnValue(null);
    const view = createSingularity(repaint);
    load();
    view.draw(canvasContext().ctx, 500, 300, 250, 150, 30, 0, true);
    expect(gl.drawArrays).not.toHaveBeenCalled();
    view.dispose();
  });
}
