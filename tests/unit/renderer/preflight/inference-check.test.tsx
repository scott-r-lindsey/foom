// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  applyUpdate,
  CheckPanel,
  startRun,
} from "../../../../src/renderer/preflight/inference-check";
import type { ProbeEvent, ProbeResult } from "../../../../src/shared/inference";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const event = (overrides: Partial<ProbeEvent>): ProbeEvent => ({
  step: "connect",
  status: "running",
  label: "Connecting to 127.0.0.1:11434",
  atMs: 0,
  ...overrides,
});
const result: ProbeResult = {
  ok: true,
  message: "needs_input · confidence 0.95 in 12.5s",
  timings: { connectMs: 1, firstTokenMs: 5400, totalMs: 12_500 },
  request: {
    url: "http://127.0.0.1:11434/v1/chat/completions",
    model: "qwen3:14b",
    parameters: { model: "qwen3:14b", stream: true },
    prompt: "Classify the sample",
  },
  reply: '{"state":"needs_input"}',
  thinking: 254,
};

test("updates replace each step's line in place, and the stream keeps the latest text", () => {
  let run = startRun("c1", 5000, 0);
  run = applyUpdate(run, { kind: "step", event: event({}) });
  run = applyUpdate(run, { kind: "step", event: event({ step: "request", label: "Sending" }) });
  run = applyUpdate(run, {
    kind: "step",
    event: event({ status: "ok", label: "Connected", durationMs: 1 }),
  });
  run = applyUpdate(run, { kind: "stream", thinking: 1, reply: "{" });
  expect(run.steps.map((step) => step.label)).toEqual(["Connected", "Sending"]);
  expect(run).toMatchObject({ thinking: 1, reply: "{" });
});

test("while running, a clock counts against the limit and Cancel is offered", () => {
  vi.useFakeTimers();
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const cancel = vi.fn();
  const run = { ...startRun("c1", 5000, 1000), steps: [event({})], thinking: 1, reply: "" };
  render(<CheckPanel run={run} onCancel={cancel} />);
  expect(screen.getByText("0.0s of 5.0s")).toBeTruthy();
  now.mockReturnValue(4100);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(screen.getByText("3.1s of 5.0s")).toBeTruthy();
  const meter = screen.getByRole("progressbar", { name: "Time limit" });
  expect(meter.getAttribute("aria-valuenow")).toBe("3100");
  expect(meter.getAttribute("aria-valuetext")).toBe("3.1 of 5.0 seconds");
  expect(screen.getByText("Thinking: 1 chunk")).toBeTruthy();
  // The clock never runs past the limit.
  now.mockReturnValue(99_000);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(screen.getByText("5.0s of 5.0s")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
});

test("a finished check shows its result, timings and the exact exchange", () => {
  const steps = [
    event({ status: "ok", label: "Connected to 127.0.0.1:11434", durationMs: 1 }),
    event({ step: "reply", status: "ok", label: "Reply complete", durationMs: 7100 }),
  ];
  const run = { ...startRun("c1", 15_000, 0), steps, thinking: 254, reply: result.reply, result };
  render(<CheckPanel run={run} onCancel={vi.fn()} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(
    "needs_input · confidence 0.95 in 12.5s. Foom will use this source.",
  );
  expect(screen.getByText("Connect 1 ms · First token 5.4 s · Total 12.5 s")).toBeTruthy();
  const list = screen.getByRole("list", { name: "Check steps" });
  expect(within(list).getByText("7.1 s")).toBeTruthy();
  expect(within(list).getByText("1 ms")).toBeTruthy();
  expect(screen.getByText(/POST http:\/\/127.0.0.1:11434\/v1\/chat\/completions/)).toBeTruthy();
  expect(screen.getByText(/"stream": true/)).toBeTruthy();
  expect(screen.getByText("Classify the sample")).toBeTruthy();
  expect(screen.getByText(/after 254 thinking chunks/)).toBeTruthy();
});

test("failures and errors are shown plainly, and screen readers hear the failing step", () => {
  const failure: ProbeResult = {
    ...result,
    ok: false,
    failure: "refused",
    message: "Connection refused: nothing is listening on 127.0.0.1:11434",
    timings: { totalMs: 3 },
    reply: "",
    thinking: 0,
  };
  const steps = [event({ status: "failed", label: failure.message, durationMs: 1 })];
  const { rerender, container } = render(
    <CheckPanel run={{ ...startRun("c1", 5000, 0), steps, result: failure }} onCancel={vi.fn()} />,
  );
  expect(container.querySelector(".check")?.getAttribute("data-tone")).toBe("error");
  expect(screen.getByRole("status").textContent).toBe(failure.message);
  expect(screen.getByText("Total 3 ms")).toBeTruthy();
  expect(screen.getByText("(none)")).toBeTruthy();
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
    `${failure.message} failed`,
  );
  rerender(
    <CheckPanel
      run={{ ...startRun("c1", 5000, 0), error: "Invalid inference model" }}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("Invalid inference model");
  expect(screen.queryByText("Details")).toBeNull();
});
