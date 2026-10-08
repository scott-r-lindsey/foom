// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SoundControls } from "../../../../src/renderer/sound/sound-controls";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
import type { SoundKind, SoundEntry } from "../../../../src/shared/sound";
const sink = vi.hoisted(() => ({
  configure: vi.fn(),
  working: vi.fn(),
  alert: vi.fn(),
  silenceAlerts: vi.fn(),
  dispose: vi.fn(),
}));
const mock = vi.hoisted(() => ({
  report: undefined as ((kind: SoundKind, reason?: string) => void) | undefined,
}));
vi.mock("../../../../src/renderer/sound/web-audio", () => ({
  createAudioSink: (_context: unknown, _api: unknown, report: typeof mock.report) => {
    mock.report = report;
    return sink;
  },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function settle(action: () => unknown) {
  await act(async () => {
    await Promise.resolve(action());
  });
}
async function fixture() {
  const entries: SoundEntry[] = [
    { kind: "done", source: "user", file: "new.wav", name: "New" },
    { kind: "done", source: "user", file: "bad.wav", name: "Bad", error: "Header mismatch" },
    { kind: "needs-you", source: "builtin", file: "typewriter-bell.ogg", name: "Typewriter bell" },
  ];
  const api = {
    list: vi.fn(() => Promise.resolve(entries)),
    openFolder: vi.fn(async () => {}),
    notices: vi.fn(() => Promise.resolve("CC0 sound credits")),
  };
  Object.defineProperty(window, "desktop", { configurable: true, value: { sounds: api } });
  const change = vi.fn();
  let view: ReturnType<typeof render>;
  await settle(() => {
    view = render(<SoundControls settings={DEFAULT_SOUND} onChange={change} />);
  });
  return { api, change, view: () => view };
}
test("saves choices, switches and volumes, previews all kinds and disposes timers", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  for (const [label, key, value] of [
    ["Working sound on", "working", true],
    ["Alerts on", "alerts", false],
  ] as const) {
    fireEvent.click(screen.getByLabelText(label));
    expect(f.change).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, [key]: value } });
  }
  fireEvent.change(screen.getByLabelText("Working volume"), { target: { value: "23" } });
  expect(f.change).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, workingVolume: 0.23 } });
  fireEvent.change(screen.getByLabelText("Alert volume"), { target: { value: "31" } });
  expect(f.change).toHaveBeenLastCalledWith({ sound: { ...DEFAULT_SOUND, alertVolume: 0.31 } });
  fireEvent.change(screen.getByLabelText("Done sound"), { target: { value: "user:new.wav" } });
  expect(f.change).toHaveBeenLastCalledWith({
    sound: {
      ...DEFAULT_SOUND,
      choices: { ...DEFAULT_SOUND.choices, done: { source: "user", file: "new.wav" } },
    },
  });
  expect(screen.getByRole("option", { name: "Bad (unavailable)" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview working" }));
  expect(sink.working).toHaveBeenCalledWith(0.6, 0.15);
  act(() => {
    vi.advanceTimersByTime(5001);
  });
  expect(sink.working).toHaveBeenLastCalledWith(0, 0);
  for (const [label, kind] of [
    ["done", "done"],
    ["needs you", "needs-you"],
    ["refusal", "refusal"],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: `Preview ${label}` }));
    expect(sink.alert).toHaveBeenLastCalledWith(kind, 0.5);
  }
  await settle(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open sounds folder" }));
  });
  expect(f.api.openFolder).toHaveBeenCalledOnce();
  await settle(() => {
    fireEvent.click(screen.getByText("Sound credits"));
  });
  expect(screen.getByText("CC0 sound credits")).toBeTruthy();
  fireEvent.click(screen.getByText("Sound credits"));
  expect(f.api.notices).toHaveBeenCalledOnce();
  f.view().unmount();
  expect(sink.dispose).toHaveBeenCalledOnce();
  const stops = sink.silenceAlerts.mock.calls.length;
  await settle(() => {
    return vi.runAllTimersAsync();
  });
  expect(sink.silenceAlerts).toHaveBeenCalledTimes(stops);
});
test("shows fallback reasons, preserves missing choices and rejects ambiguous attention", async () => {
  const f = await fixture();
  act(() => mock.report?.("done", "Missing. Using the default sound."));
  expect(screen.getByRole("status").textContent).toContain("Missing");
  fireEvent.change(screen.getByLabelText("Needs you sound"), {
    target: { value: "builtin:typewriter-bell.ogg" },
  });
  expect(screen.getByRole("alert").textContent).toContain("different file");
  expect(f.change).not.toHaveBeenCalled();
  f.view().rerender(
    <SoundControls
      settings={{
        ...DEFAULT_SOUND,
        choices: { ...DEFAULT_SOUND.choices, done: { source: "user", file: "missing.wav" } },
      }}
      onChange={f.change}
    />,
  );
  expect(screen.getByRole("option", { name: "Missing" })).toBeTruthy();
  f.api.openFolder.mockRejectedValueOnce(Error("permission"));
  await settle(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open sounds folder" }));
  });
  expect(screen.getByRole("alert").textContent).toContain("Unable to open");
  f.api.notices.mockRejectedValueOnce(Error("gone"));
  await settle(() => {
    fireEvent.click(screen.getByText("Sound credits"));
  });
  expect(screen.getByRole("alert").textContent).toContain("Unable to read");
  f.view().unmount();
  render(<SoundControls settings={DEFAULT_SOUND} onChange={f.change} />);
  await settle(() => {});
  expect(f.api.list).toHaveBeenCalledTimes(2);
});
test("failed and late catalog responses do not break or update an unmounted view", async () => {
  const f = await fixture();
  f.view().unmount();
  f.api.list.mockRejectedValueOnce(Error("disk"));
  await settle(() => {
    render(<SoundControls settings={DEFAULT_SOUND} onChange={f.change} />);
  });
  expect(screen.getByRole("alert").textContent).toContain("Unable to list");
  cleanup();
  let resolve: ((value: SoundEntry[]) => void) | undefined;
  f.api.list.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<SoundControls settings={DEFAULT_SOUND} onChange={f.change} />);
  view.unmount();
  await settle(() => {
    resolve?.([]);
    mock.report?.("done", "late");
  });
});

test("ignores stale selections and late catalog failures", async () => {
  const f = await fixture();
  fireEvent.change(screen.getByLabelText("Done sound"), { target: { value: "user:stale.wav" } });
  expect(f.change).not.toHaveBeenCalled();
  f.change.mockImplementationOnce(() => {
    throw new Error("Save unavailable");
  });
  fireEvent.click(screen.getByLabelText("Alerts on"));
  expect(screen.getByRole("alert").textContent).toBe("Save unavailable");
  f.view().unmount();
  let reject: ((error: Error) => void) | undefined;
  f.api.list.mockReturnValueOnce(
    new Promise((_resolve, r) => {
      reject = r;
    }),
  );
  const view = render(<SoundControls settings={DEFAULT_SOUND} onChange={f.change} />);
  view.unmount();
  await settle(() => {
    reject?.(Error("late"));
  });
});
