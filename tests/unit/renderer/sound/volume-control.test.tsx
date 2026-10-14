// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VolumeControl } from "../../../../src/renderer/sound/volume-control";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
afterEach(cleanup);
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
