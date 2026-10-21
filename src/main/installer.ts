import type { App } from "electron";
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** Squirrel invokes lifecycle callbacks before the normal application starts. */
export function handleInstaller(
  app: Pick<App, "isPackaged" | "quit">,
  platform = process.platform,
  argv = process.argv,
  executable = process.execPath,
  execute: (
    file: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number },
    callback: (error: Error | null) => void,
  ) => unknown = execFile,
): boolean {
  if (platform !== "win32" || !app.isPackaged) return false;
  const event = argv[1];
  if (event === "--squirrel-obsolete") {
    app.quit();
    return true;
  }
  if (!["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall"].includes(event ?? ""))
    return false;
  execute(
    resolve(dirname(executable), "..", "Update.exe"),
    [
      event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut",
      basename(executable),
    ],
    { windowsHide: true, timeout: 10000 },
    () => {
      app.quit();
    },
  );
  return true;
}
