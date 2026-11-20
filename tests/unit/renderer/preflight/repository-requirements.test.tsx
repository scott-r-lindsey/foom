// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RepositoryRequirementsCards } from "../../../../src/renderer/preflight/repository-requirements";
import type { RepositoryRequirementsApi } from "../../../../src/shared/repository-requirements";

afterEach(cleanup);
const repository = { path: "/fixture/repo", name: "repo" };
const note = {
  markdown: "<img src=x>\n# Notes",
  revision: "13d2354c-75d5-4771-8d2a-f0179896e640",
  agent: "Codex",
  host: "worker",
  recordedAt: 1700000000000,
};

function setup() {
  const request = vi.fn<RepositoryRequirementsApi["repositoryRequirements"]>();
  const view = render(
    <RepositoryRequirementsCards repositories={[repository]} request={request} />,
  );
  const summary = view.container.querySelector("summary");
  if (!summary) throw new Error("Missing card");
  const toggle = () => {
    fireEvent.click(summary);
  };
  return { request, toggle };
}

test("displays Markdown text and edits and clears against the visible revision", async () => {
  const { request, toggle } = setup();
  request.mockResolvedValueOnce(note);
  toggle();
  await screen.findByText(/Recorded by Codex on worker/u);
  expect(screen.queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Host requirements Markdown" });
  fireEvent.change(editor, { target: { value: " " } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const edited = { ...note, markdown: "A revised dependency", editedAt: 1700000000000 };
  fireEvent.change(screen.getByRole("textbox"), { target: { value: edited.markdown } });
  request.mockResolvedValueOnce(edited);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/edited by you/u);
  expect(request).toHaveBeenCalledWith({
    action: "edit",
    repository: repository.path,
    markdown: edited.markdown,
    revision: note.revision,
  });
  request.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await screen.findByText("No recorded requirements");
  expect(request).toHaveBeenCalledWith({
    action: "clear",
    repository: repository.path,
    revision: note.revision,
  });
});

test("shows read errors and keeps the note visible when clearing fails", async () => {
  const { request, toggle } = setup();
  request.mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce(note);
  toggle();
  await screen.findByText("Unable to read host requirements");
  toggle();
  toggle();
  await screen.findByText(/Recorded by Codex on worker/u);
  request.mockRejectedValueOnce(new Error("write failed"));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await screen.findByText(/Unable to save host requirements/u);
  expect(screen.getByText(/Recorded by Codex on worker/u)).toBeTruthy();
});
