// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VolumeControl } from "../../../../src/renderer/sound/volume-control";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("speaker shapes, mute, retained level and slider release samples", () => {
  const change = vi.fn(),
    sample = vi.fn();
  const view = render(
    <VolumeControl settings={DEFAULT_SOUND} onChange={change} onSample={sample} />,
  );
  const slider = view.getByRole("slider");
  expect(view.container.querySelectorAll("path")).toHaveLength(3);
  fireEvent.click(view.getByRole("button", { name: "Mute" }));
  expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_SOUND, muted: true });
  expect(sample).not.toHaveBeenCalled();
  const muted = { ...DEFAULT_SOUND, muted: true, volume: 0.4 };
  view.rerender(<VolumeControl settings={muted} onChange={change} onSample={sample} />);
  expect(slider.getAttribute("aria-valuetext")).toBe("Muted");
  expect(view.container.querySelectorAll("path")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "Unmute" }));
  expect(sample).toHaveBeenLastCalledWith({ ...muted, muted: false });
  fireEvent.change(slider, { target: { value: "25" } });
  expect(change).toHaveBeenLastCalledWith({ ...muted, volume: 0.25, muted: false });
  fireEvent.pointerUp(slider);
  expect(sample).toHaveBeenLastCalledWith(muted);
  fireEvent.keyUp(slider, { key: "ArrowRight" });
  expect(sample).toHaveBeenCalledTimes(3);
  fireEvent.keyUp(slider, { key: "Tab" });
  expect(sample).toHaveBeenCalledTimes(3);
  view.rerender(
    <VolumeControl
      settings={{ ...DEFAULT_SOUND, volume: 0.4 }}
      onChange={change}
      onSample={sample}
    />,
  );
  expect(view.container.querySelectorAll("path")).toHaveLength(2);
  view.rerender(
    <VolumeControl
      settings={{ ...DEFAULT_SOUND, volume: 0 }}
      onChange={change}
      onSample={sample}
    />,
  );
  expect(view.container.querySelector("path:last-child")?.getAttribute("d")).toContain("l3 3");
});

test("wheel over speaker and slider accumulates, unmutes, clamps and samples once after settling", () => {
  vi.useFakeTimers();
  let settings = { ...DEFAULT_SOUND, muted: true, volume: 0.5 };
  const sample = vi.fn();
  const change = vi.fn((next: typeof settings) => {
    settings = next;
    view.rerender(<VolumeControl settings={settings} onChange={change} onSample={sample} />);
  });
  const view = render(<VolumeControl settings={settings} onChange={change} onSample={sample} />);
  fireEvent.wheel(view.getByRole("button"), { deltaY: -20 });
  fireEvent.wheel(view.getByRole("slider"), { deltaY: -29 });
  expect(change).not.toHaveBeenCalled();
  fireEvent.wheel(view.getByRole("slider"), { deltaY: -1 });
  expect(settings).toEqual({ ...DEFAULT_SOUND, volume: 0.55, muted: false });
  act(() => {
    vi.advanceTimersByTime(100);
  });
  fireEvent.wheel(view.getByRole("button"), { deltaY: -1, deltaMode: 1 });
  expect(settings.volume).toBe(0.6);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  fireEvent.wheel(view.getByRole("slider"), { deltaY: -1 });
  act(() => {
    vi.advanceTimersByTime(149);
  });
  expect(sample).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(sample).toHaveBeenCalledExactlyOnceWith(settings);
  fireEvent.wheel(view.getByRole("slider"), { deltaY: 1, deltaMode: 2 });
  expect(settings.volume).toBe(0.55);
  for (let i = 0; i < 25; i++) fireEvent.wheel(view.getByRole("slider"), { deltaY: 50 });
  expect(settings.volume).toBe(0);
  for (let i = 0; i < 25; i++) fireEvent.wheel(view.getByRole("button"), { deltaY: -50 });
  expect(settings.volume).toBe(1);
  act(() => {
    vi.advanceTimersByTime(150);
  });
  expect(sample).toHaveBeenCalledTimes(2);
  expect(sample).toHaveBeenLastCalledWith(settings);
  fireEvent.wheel(view.getByRole("slider"), { deltaY: 50 });
  view.unmount();
  act(() => {
    vi.advanceTimersByTime(150);
  });
  expect(sample).toHaveBeenCalledTimes(2);
});
