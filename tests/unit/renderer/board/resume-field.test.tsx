// @vitest-environment jsdom
import type { ArmedConfirmation, ConfirmationClient } from "../../../../src/shared/confirmation";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { parseResume } from "../../../../src/renderer/board/resume-field";
import { ResumeField } from "../../../../src/renderer/board/resume-field-view";
afterEach(cleanup);
test.each([
  [" abc_123-xyz ", { id: "abc_123-xyz" }],
  ["claude --resume abc", { agent: "claude", id: "abc" }],
  ["claude -r abc", { agent: "claude", id: "abc" }],
  [" codex resume abc ", { agent: "codex", id: "abc" }],
  ["agy --conversation abc", { agent: "agy", id: "abc" }],
  ["a".repeat(200), { id: "a".repeat(200) }],
])("parses %s", (text, expected) => {
  expect(parseResume(text)).toEqual(expected);
});
test.each([
  "",
  " ",
  "--last",
  "-x",
  "_abc",
  "abc def",
  "a/b",
  "../abc",
  "a".repeat(201),
  "claude --resume --all",
  "claude --resume abc --dangerously-skip-permissions",
  "codex resume a b",
  "codex resume $(id)",
  "codex resume abc;ls",
  "claude -r 'abc'",
  "claude --resume=abc",
  "agy --continue abc",
  "other resume abc",
  "codex fork abc",
  "claude -r",
  "agy --conversation /tmp/id",
  "abc\0",
  "abc\nxyz",
  "claude --resume abc\nwhoami",
  "é",
  "claude\n--resume\nabc",
])("rejects %s", (text) => {
  expect(parseResume(text)).toBeUndefined();
});

test("bare IDs require a choice, line agents must be offered, and Escape cancels", async () => {
  const launch = vi.fn(async () => {}),
    back = vi.fn();
  const view = render(<ResumeField agents={["claude", "codex"]} launch={launch} back={back} />);
  const input = view.getByRole("textbox");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "abc" } });
  expect(view.queryByRole("button", { name: "Antigravity" })).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(launch).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Codex" }));
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(launch).toHaveBeenCalledWith("codex", "abc");
  for (const value of ["agy --conversation abc", "bogus resume abc"]) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
  }
  expect(launch).toHaveBeenCalledOnce();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(back).toHaveBeenCalledOnce();
});

test("launch errors mark the field and it can be edited and retried", async () => {
  const launch = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue(undefined);
  const view = render(<ResumeField agents={["claude"]} launch={launch} back={() => {}} />);
  const input = view.getByRole("textbox");
  fireEvent.change(input, { target: { value: "claude -r abc" } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "claude --resume def" } });
  expect(input.getAttribute("aria-invalid")).toBe("false");
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(launch).toHaveBeenLastCalledWith("claude", "def");
});

test("shared-checkout confirmation waits for main and prevents duplicate submission", async () => {
  let receive: (arm: ArmedConfirmation | null, accepted?: boolean) => void = () => {};
  const operation = Promise.withResolvers<undefined>();
  const arm = {
    nonce: "main-owned",
    target: "resume",
    label: "Click again for multiple agents here",
  };
  const confirm = vi.fn(() => {
    receive(null, true);
    operation.resolve(undefined);
    return Promise.resolve();
  });
  const client: ConfirmationClient = {
    subscribe(callback) {
      receive = callback;
      return () => {};
    },
    confirm,
    cancel: vi.fn(() => Promise.resolve()),
  };
  const launch = vi.fn(() => operation.promise);
  const view = render(
    <ResumeField agents={["claude"]} confirmations={client} launch={launch} back={() => {}} />,
  );
  const input = view.getByRole("textbox");
  fireEvent.change(input, { target: { value: "claude --resume abc" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(launch).toHaveBeenCalledOnce();
  act(() => {
    receive(arm);
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: arm.label }));
    await operation.promise;
  });
  expect(confirm).toHaveBeenCalledWith(arm);
  expect(document.activeElement).toBe(input);
});

test("confirmation expiry preserves the paste and agent choice for retry", async () => {
  let receive: (arm: ArmedConfirmation | null, accepted?: boolean) => void = () => {};
  const operation = Promise.withResolvers<undefined>();
  const client: ConfirmationClient = {
    subscribe(callback) {
      receive = callback;
      return () => {};
    },
    confirm: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  const done = vi.fn();
  const launch = vi.fn(() => operation.promise);
  const view = render(
    <ResumeField
      agents={["claude"]}
      confirmations={client}
      launch={launch}
      back={() => {}}
      done={done}
    />,
  );
  const input = view.getByRole("textbox");
  fireEvent.change(input, { target: { value: "external-123" } });
  fireEvent.click(view.getByRole("button", { name: "Claude Code" }));
  fireEvent.keyDown(input, { key: "Enter" });
  act(() => {
    receive({ nonce: "n", target: "t", label: "Click again" });
  });
  await act(async () => {
    receive(null, false);
    operation.resolve(undefined);
    await operation.promise;
  });
  expect(done).not.toHaveBeenCalled();
  expect(view.getByDisplayValue("external-123")).toBe(input);
  expect(document.activeElement).toBe(input);
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(launch).toHaveBeenCalledTimes(2);
  expect(done).toHaveBeenCalledOnce();
});

test("approved plugin paste patterns are bounded and ambiguous commands require an explicit choice", async () => {
  const patterns = [{ agent: "fixture-v2", command: "fixture-v2", selector: "--resume" }];
  expect(parseResume("fixture-v2 --resume saved", patterns)).toEqual({
    agent: "fixture-v2",
    id: "saved",
  });
  expect(parseResume("fixture-v2 --resume saved --extra", patterns)).toBeUndefined();
  expect(parseResume(" ".repeat(513) + "saved", patterns)).toBeUndefined();
  expect(
    parseResume("fixture-v2 --resume saved", [
      ...patterns,
      { ...patterns[0], agent: "other", command: "fixture-v2", selector: "--resume" },
    ]),
  ).toEqual({ id: "saved" });
  const launch = vi.fn(async () => {});
  const view = render(
    <ResumeField agents={["fixture-v2"]} patterns={patterns} launch={launch} back={() => {}} />,
  );
  fireEvent.change(view.getByRole("textbox"), { target: { value: "fixture-v2 --resume saved" } });
  await act(async () => {
    fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
    await Promise.resolve();
  });
  expect(launch).toHaveBeenCalledWith("fixture-v2", "saved");
});
