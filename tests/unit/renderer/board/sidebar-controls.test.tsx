// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SidebarControls } from "../../../../src/renderer/board/sidebar-controls";
import { setupState } from "../../../fixtures/setup";
import type { SettingsPatch, SetupState } from "../../../../src/shared/setup";
const sink = vi.hoisted(() => ({
  configure: vi.fn(),
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
async function settle(action: () => unknown = () => {}) {
  await act(async () => {
    await Promise.resolve(action());
  });
}
function fixture() {
  let state = setupState();
  let receive: ((next: SetupState) => void) | undefined;
  const off = vi.fn();
  const source = {
    state: vi.fn(() => Promise.resolve(state)),
    subscribe: (listener: (next: SetupState) => void) => {
      receive = listener;
      return off;
    },
    save: vi.fn((patch: SettingsPatch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      receive?.(state);
      return Promise.resolve(state);
    }),
  };
  const send = (next: SetupState) => {
    state = next;
    receive?.(state);
  };
  return { source, send, off };
}
test("zoom shares settings, resets, stops at limits and volume samples respect the master", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const view = render(<SidebarControls source={f.source} />);
  await settle();
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Zoom in" })));
  expect(f.source.save).toHaveBeenLastCalledWith({ interfaceScale: 110 });
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Zoom out" })));
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Zoom 100%" })));
  act(() => {
    f.send(setupState({ interfaceScale: 300 }));
  });
  expect(view.getByRole("button", { name: "Zoom in" })).toHaveProperty("disabled", true);
  await settle(() =>
    fireEvent.click(view.getByRole("button", { name: "Zoom 300%, reset to 100%" })),
  );
  expect(f.source.save).toHaveBeenLastCalledWith({ interfaceScale: 100 });
  act(() => {
    f.send(setupState({ interfaceScale: 80 }));
  });
  expect(view.getByRole("button", { name: "Zoom out" })).toHaveProperty("disabled", true);
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Mute" })));
  expect(sink.silenceAlerts).toHaveBeenCalled();
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Unmute" })));
  expect(sink.alert).toHaveBeenLastCalledWith("done", 0.5);
  await settle(() => fireEvent.change(view.getByRole("slider"), { target: { value: "40" } }));
  fireEvent.pointerUp(view.getByRole("slider"));
  expect(sink.alert).toHaveBeenLastCalledWith("done", 0.2);
  const silences = sink.silenceAlerts.mock.calls.length;
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(sink.silenceAlerts).toHaveBeenCalledTimes(silences + 1);
  view.unmount();
  expect(f.off).toHaveBeenCalledOnce();
  expect(sink.dispose).toHaveBeenCalledOnce();
});
test("latest edit survives delayed saves and their broadcasts", async () => {
  const f = fixture();
  let finish: ((state: SetupState) => void) | undefined;
  f.source.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<SidebarControls source={f.source} />);
  await settle();
  fireEvent.change(view.getByRole("slider"), { target: { value: "40" } });
  fireEvent.change(view.getByRole("slider"), { target: { value: "70" } });
  act(() => {
    f.send(setupState());
  });
  expect(view.getByRole("slider")).toHaveProperty("value", "70");
  await settle(() => finish?.(setupState()));
  expect(f.source.save).toHaveBeenCalledTimes(2);
  expect(view.getByRole("slider")).toHaveProperty("value", "70");
});
test("failed saves restore authoritative settings and failed refresh leaves the view usable", async () => {
  const f = fixture();
  const view = render(<SidebarControls source={f.source} />);
  await settle();
  f.source.save.mockRejectedValueOnce(Error("disk"));
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Zoom in" })));
  expect(view.getByRole("button", { name: "Zoom 100%" })).toBeTruthy();
  f.source.save.mockRejectedValueOnce(Error("disk"));
  f.source.state.mockRejectedValueOnce(Error("offline"));
  await settle(() => fireEvent.click(view.getByRole("button", { name: "Zoom in" })));
  expect(view.getByRole("button", { name: "Zoom 110%, reset to 100%" })).toBeTruthy();
});
test("subscription wins a stale initial read; teardown ignores late reads", async () => {
  const f = fixture();
  let finish: ((state: SetupState) => void) | undefined;
  f.source.state.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<SidebarControls source={f.source} />);
  act(() => {
    f.send(setupState({ interfaceScale: 150 }));
  });
  await settle(() => finish?.(setupState()));
  expect(view.getByRole("button", { name: "Zoom 150%, reset to 100%" })).toBeTruthy();
  view.unmount();
  f.source.state.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const late = render(<SidebarControls source={f.source} />);
  late.unmount();
  await settle(() => finish?.(setupState()));
  act(() => {
    f.send(setupState());
  });
  f.source.state.mockRejectedValueOnce(Error("offline"));
  render(<SidebarControls source={f.source} />);
  await settle();
});
test("sample boards without a settings source remain usable", () => {
  const view = render(<SidebarControls source={undefined} />);
  fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
  expect(view.getByRole("button", { name: "Zoom 110%, reset to 100%" })).toBeTruthy();
});
