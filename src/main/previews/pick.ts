import path from "node:path";
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import type { PreviewHost } from "./host";

/** Only main chooses document paths; the inventory path identifies the checkout. */
export async function pickPreviewFile(
  window: BrowserWindow,
  host: Pick<PreviewHost, "open">,
  validate: (worktree: string) => Promise<void>,
  worktree: string,
): Promise<string | null> {
  await validate(worktree);
  // Dismiss command panels before the native picker can blur their pending action.
  // Otherwise cancellation can leave a panel covering the newly loaded preview.
  window.webContents.send("confirmation:dialog");
  const result = await dialog.showOpenDialog(window, {
    title: "Preview file",
    defaultPath: worktree,
    properties: ["openFile"],
    filters: [{ name: "Markdown and HTML", extensions: ["md", "markdown", "html", "htm"] }],
  });
  if (result.canceled) return null;
  const chosen = result.filePaths[0];
  if (result.filePaths.length !== 1 || !chosen || !path.isAbsolute(chosen))
    throw new Error("Invalid preview selection");
  // Host revalidates inventory after the dialog and applies contained-file checks.
  return host.open(worktree, path.relative(worktree, chosen).split(path.sep).join("/"));
}
