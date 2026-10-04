// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SoundControls } from "../../../../src/renderer/sound/sound-controls";
import { DEFAULT_SOUND, SOUNDSCAPES } from "../../../../src/shared/soundscapes";
const sink = vi.hoisted(() => ({
  working: vi.fn(),
  alert: vi.fn(),
  silenceAlerts: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../../../../src/renderer/sound/web-audio", () => ({ createAudioSink: () => sink }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
test("saves independent switches, volumes and choice and previews every sound with bounded cleanup", () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  const view = render(<SoundControls settings={DEFAULT_SOUND} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText("Working sound on"));
  expect(onChange).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, working: true } });
  fireEvent.click(screen.getByLabelText("Alerts on"));
  expect(onChange).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, alerts: false } });
  fireEvent.change(screen.getByLabelText("Working volume"), { target: { value: "23" } });
  expect(onChange).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, workingVolume: 0.23 } });
  fireEvent.change(screen.getByLabelText("Alert volume"), { target: { value: "31" } });
  expect(onChange).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, alertVolume: 0.31 } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "soft" } });
  expect(onChange).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, soundscape: "soft" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview working" }));
  act(() => {
    vi.advanceTimersByTime(2100);
  });
  expect(sink.working).toHaveBeenCalledWith(0.6, 0.15, SOUNDSCAPES.drive);
  const calls = sink.working.mock.calls.length;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(sink.working).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByRole("button", { name: "Preview needs you" }));
  expect(sink.alert).toHaveBeenLastCalledWith("needsYou", 0.5, SOUNDSCAPES.drive);
  fireEvent.click(screen.getByRole("button", { name: "Preview done" }));
  expect(sink.alert).toHaveBeenLastCalledWith("done", 0.5, SOUNDSCAPES.drive);
  view.rerender(
    <SoundControls
      settings={{ ...DEFAULT_SOUND, soundscape: SOUNDSCAPES.soft }}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("combobox")).toHaveProperty("value", "custom");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "drive" } });
  expect(onChange).toHaveBeenLastCalledWith({ sound: DEFAULT_SOUND });
  view.unmount();
  expect(sink.dispose).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
