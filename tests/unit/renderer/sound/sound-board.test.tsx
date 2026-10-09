// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import * as audio from "../../../../src/renderer/sound/web-audio";
import { setupState } from "../../../fixtures/setup";
import { REPEAT_MS } from "../../../../src/renderer/sound/sound-controller";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("board uses the displayed terminal and window focus for muting and disposes audio on unmount", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const sink = {
    configure: vi.fn(),
    working: vi.fn(),
    alert: vi.fn(),
    silenceAlerts: vi.fn(),
    dispose: vi.fn(),
  };
  vi.spyOn(audio, "createAudioSink").mockReturnValue(sink);
  const source = createSampleSource([
    {
      id: "a",
      kind: "agent",
      agent: "Claude",
      repository: "Local",
      branch: "Shell",
      state: "working",
      reason: "Running",
      waitingSince: 0,
      rate: 0,
      seen: false,
      tail: [],
    },
  ]);
  const soundSetup = { state: () => Promise.resolve(setupState()), subscribe: () => () => {} };
  const view = render(<Board source={source} soundSetup={soundSetup} />);
  await act(async () => {
    await Promise.resolve();
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing terminal row");
  fireEvent.click(row);
  act(() => {
    source.update("a", { state: "needs_input" });
    vi.advanceTimersByTime(1200);
  });
  expect(sink.alert).not.toHaveBeenCalled();
  focused.mockReturnValue(false);
  act(() => {
    vi.advanceTimersByTime(REPEAT_MS);
  });
  expect(sink.alert).toHaveBeenCalledOnce();
  focused.mockReturnValue(true);
  view.rerender(
    <Board source={source} soundSetup={soundSetup} settingsView={<div>Settings</div>} />,
  );
  act(() => {
    source.update("a", {
      state: "done",
      execution: { terminalId: "a", launch: 1, revision: 2, turn: 1, phase: "idle" },
    });
    vi.advanceTimersByTime(2100);
  });
  expect(sink.alert).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(sink.dispose).toHaveBeenCalledOnce();
});

test("completion is audible in the focused tile while focused attention is muted", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const sink = {
    configure: vi.fn(),
    working: vi.fn(),
    alert: vi.fn(),
    silenceAlerts: vi.fn(),
    dispose: vi.fn(),
  };
  vi.spyOn(audio, "createAudioSink").mockReturnValue(sink);
  const source = createSampleSource(
    ["a", "b"].map((id) => ({
      id,
      kind: "agent",
      agent: "Claude",
      repository: "Local",
      branch: id,
      state: "working",
      reason: "Running",
      waitingSince: 0,
      rate: 0,
      seen: false,
      tail: [],
    })),
  );
  const soundSetup = { state: () => Promise.resolve(setupState()), subscribe: () => () => {} };
  const view = render(<Board source={source} soundSetup={soundSetup} />);
  await act(async () => {
    await Promise.resolve();
  });
  const rows = view.container.querySelectorAll(".board-row");
  const first = rows[0];
  const second = rows[1];
  if (!first || !second) throw Error("Missing terminal rows");
  fireEvent.click(first);
  fireEvent.click(view.getByRole("button", { name: "Tile 1 menu" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Split right" }));
  fireEvent.click(second);
  act(() => {
    source.update("b", {
      state: "done",
      execution: { terminalId: "b", launch: 1, revision: 2, turn: 1, phase: "idle" },
    });
    vi.advanceTimersByTime(1200);
  });
  expect(sink.alert).toHaveBeenCalledOnce();
  act(() => {
    source.update("a", {
      state: "done",
      execution: { terminalId: "a", launch: 1, revision: 2, turn: 1, phase: "idle" },
    });
    vi.advanceTimersByTime(2200);
  });
  expect(sink.alert).toHaveBeenCalledTimes(2);
  fireEvent.click(first);
  act(() => {
    source.update("a", { state: "needs_input" });
    vi.advanceTimersByTime(2100);
  });
  expect(sink.alert).toHaveBeenCalledTimes(2);
  act(() => {
    source.update("b", { state: "needs_input" });
    vi.advanceTimersByTime(1200);
  });
  expect(sink.alert).toHaveBeenCalledTimes(3);
});
