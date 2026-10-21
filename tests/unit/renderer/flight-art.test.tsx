// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createFlightArt, type Palette } from "../../../src/renderer/ui/flight-art";
import { FlightCanvas } from "../../../src/renderer/ui/flight-canvas";
import { canvasContext } from "./flight-canvas-fixture";
const palette: Palette = {
  mode: "dark",
  star: "#F4EFFF",
  accent: "#9B6BFF",
  deep: "#7A3CFF",
  hot: "#F4EFFF",
  cool: "#7A3CFF",
  hull: "#F4EFFF",
  outline: "transparent",
  hole: "#06050B",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("flight rolls from horizontal to vertical; ignition, trail, warp and final still are drawn", () => {
  const { ctx, draw, gradient } = canvasContext();
  const art = createFlightArt();
  art(ctx, 1000, 650, 0, palette, true, false);
  const flat = draw.rotate.mock.calls.at(-1)?.[0];
  expect(flat).toBeGreaterThan(1.4);
  draw.createLinearGradient.mockClear();
  art(ctx, 1000, 650, 1401, palette, true, false);
  expect(draw.createLinearGradient).toHaveBeenCalled();
  for (let t = 1450; t <= 4500; t += 50) art(ctx, 1000, 650, t, palette, true, false);
  expect(draw.rotate.mock.calls.at(-1)?.[0]).toBeLessThan(flat ?? 0);
  expect(draw.lineTo).toHaveBeenCalled();
  expect(gradient.addColorStop).toHaveBeenCalledWith(0, palette.hull);
  art(ctx, 1000, 650, 0, palette, true, true);
  expect(draw.rotate.mock.calls.at(-1)?.[0]).toBeLessThan(0.4);
});
test("About keeps the hole black in both skies and reduced motion freezes bob and flame", () => {
  for (const mode of ["light", "dark"]) {
    const { ctx, draw } = canvasContext();
    const art = createFlightArt();
    art(ctx, 540, 380, 1000, { ...palette, mode }, false, true);
    const bob = draw.translate.mock.calls.at(-1);
    const flame = draw.quadraticCurveTo.mock.calls.at(-1);
    art(ctx, 540, 380, 2000, { ...palette, mode }, false, true);
    expect(draw.translate.mock.calls.at(-1)).toEqual(bob);
    expect(draw.quadraticCurveTo.mock.calls.at(-1)).toEqual(flame);
    art(ctx, 540, 380, 2000, { ...palette, mode }, false, false);
    expect(draw.translate.mock.calls.at(-1)).not.toEqual(bob);
  }
});
test("canvas pauses on blur, resumes on focus and disposes its loop", () => {
  const { ctx } = canvasContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  let callback: FrameRequestCallback | undefined;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((next: FrameRequestCallback) => {
      callback = next;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 0 });
  const view = render(<FlightCanvas />);
  callback?.(1);
  fireEvent.blur(window);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  fireEvent.focus(window);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(cancelAnimationFrame).toHaveBeenCalledTimes(3);
});
