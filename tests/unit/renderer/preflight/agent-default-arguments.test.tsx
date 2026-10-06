// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentDefaultArguments } from "../../../../src/renderer/preflight/agent-default-arguments";

afterEach(cleanup);
const empty = { claude: [], codex: [], agy: [] };

test("edits each agent as literal lines, waits for save, and clears a list", async () => {
  let resolve: (() => void) | undefined;
  const save = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(
    <AgentDefaultArguments defaults={{ ...empty, codex: ["--model", "old"] }} save={save} />,
  );
  const claude = screen.getByLabelText("Claude Code default arguments");
  fireEvent.change(claude, { target: { value: "--model\na model\n'literal quotes'" } });
  fireEvent.change(screen.getByLabelText("Codex default arguments"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Antigravity default arguments"), {
    target: { value: "--mode\nplan" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save default arguments" }));
  const defaults = {
    claude: ["--model", "a model", "'literal quotes'"],
    codex: [],
    agy: ["--mode", "plan"],
  };
  expect(save).toHaveBeenCalledExactlyOnceWith(defaults);
  expect(claude).toHaveProperty("disabled", true);
  view.rerender(<AgentDefaultArguments defaults={defaults} save={save} />);
  await act(async () => {
    resolve?.();
    await Promise.resolve();
  });
  expect(screen.getByRole("status").textContent).toContain("saved");
  expect(claude).toHaveProperty("value", defaults.claude.join("\n"));
  expect(claude).toHaveProperty("disabled", false);
});

test("keeps a refused draft for correction, reports errors, and preserves blank lines for validation", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Reserved argument"));
  render(<AgentDefaultArguments defaults={empty} save={save} />);
  const input = screen.getByLabelText("Codex default arguments");
  fireEvent.change(input, { target: { value: "--config=notify=[]\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save default arguments" }));
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toBe("Reserved argument");
  });
  expect(save).toHaveBeenCalledWith({ ...empty, codex: ["--config=notify=[]", ""] });
  expect(input).toHaveProperty("value", "--config=notify=[]\n");
  fireEvent.change(input, { target: { value: "--model\nx" } });
  expect(screen.getByRole("status").textContent).toBe("");
});
