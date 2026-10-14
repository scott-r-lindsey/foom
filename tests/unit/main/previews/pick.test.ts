import path from "node:path";
import type { BrowserWindow } from "electron";
import { expect, test, vi } from "vitest";
const show = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ dialog: { showOpenDialog: show } }));
import { pickPreviewFile } from "../../../../src/main/previews/pick";
const send = vi.fn();
const window = { webContents: { send } } as unknown as BrowserWindow;
test("validates before showing the main-owned picker, revalidating through the host on selection", async () => {
  const root = path.resolve("checkout");
  const validate = vi.fn(async () => {});
  const host = { open: vi.fn(() => Promise.resolve("preview")) };
  show.mockResolvedValue({ canceled: false, filePaths: [path.join(root, "docs", "page.html")] });
  expect(await pickPreviewFile(window, host, validate, root)).toBe("preview");
  expect(validate).toHaveBeenCalledWith(root);
  expect(send).toHaveBeenCalledWith("confirmation:dialog");
  expect(send.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0] ?? 0);
  expect(show).toHaveBeenCalledWith(window, {
    title: "Preview file",
    defaultPath: root,
    properties: ["openFile"],
    filters: [{ name: "Markdown and HTML", extensions: ["md", "markdown", "html", "htm"] }],
  });
  expect(host.open).toHaveBeenCalledWith(root, "docs/page.html");
  validate.mockRejectedValueOnce(new Error("Unknown worktree"));
  show.mockClear();
  send.mockClear();
  await expect(pickPreviewFile(window, host, validate, root)).rejects.toThrow("Unknown worktree");
  expect(show).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
test("cancel and malformed selections create no preview; host refusals propagate", async () => {
  const root = path.resolve("checkout");
  const host = { open: vi.fn(() => Promise.resolve("preview")) };
  const validate = async () => {};
  show.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await pickPreviewFile(window, host, validate, root)).toBeNull();
  for (const filePaths of [
    [],
    [""],
    ["relative.md"],
    [path.join(root, "a.md"), path.join(root, "b.md")],
  ]) {
    show.mockResolvedValue({ canceled: false, filePaths });
    await expect(pickPreviewFile(window, host, validate, root)).rejects.toThrow(
      "Invalid preview selection",
    );
  }
  expect(host.open).not.toHaveBeenCalled();
  host.open.mockRejectedValue(new Error("Preview file unavailable"));
  show.mockResolvedValue({ canceled: false, filePaths: [path.resolve("outside.html")] });
  await expect(pickPreviewFile(window, host, validate, root)).rejects.toThrow(
    "Preview file unavailable",
  );
  expect(host.open).toHaveBeenCalledWith(root, "../outside.html");
});
