// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { argumentLines } from "../../../../src/renderer/preflight/agent-default-arguments";

afterEach(cleanup);

test.each([
  ["--model\nopus\n\n", ["--model", "opus"]],
  ["--model\r\nopus\r\n\r\n", ["--model", "opus"]],
  ["\r\n\r\n", []],
  ["", []],
  ["--model\n\nopus\n", ["--model", "", "opus"]],
  ["  literal spaces  \n'quotes'\n", ["  literal spaces  ", "'quotes'"]],
  ["a\rb\n", ["a\rb"]],
])("normalizes only line endings and trailing blank lines: %j", (text, expected) => {
  expect(argumentLines(text)).toEqual(expected);
});

test("in-place defaults save on blur, preserve refused drafts, and disclose builtin bypass", async () => {
  const { AgentArguments } = await import(
    "../../../../src/renderer/preflight/agent-default-arguments"
  );
  const save = vi.fn().mockRejectedValueOnce(Error("Cancelled")).mockResolvedValue(undefined);
  const view = render(<AgentArguments id="claude" name="Claude Code" value={[]} save={save} />);
  const input = screen.getByRole("textbox");
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "--dangerously-skip-permissions" } });
  expect(screen.getByText(/Bypass approvals/)).toBeTruthy();
  fireEvent.blur(input);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Unable to update settings.",
  );
  expect(input).toHaveProperty("value", "--dangerously-skip-permissions");
  fireEvent.change(input, { target: { value: "--model\nnew" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.blur(input);
  await waitFor(() => {
    expect(save).toHaveBeenLastCalledWith(["--model", "new"]);
  });
  view.rerender(
    <AgentArguments id="claude" name="Claude Code" value={["--model", "new"]} save={save} />,
  );
  await waitFor(() => {
    expect(input).toHaveProperty("disabled", false);
  });
  expect(input).toHaveProperty("value", "--model\nnew");
});
