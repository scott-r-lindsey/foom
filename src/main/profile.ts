import type { App } from "electron";
import { join } from "node:path";

/** Select before ready, sessions, locks, or any profile store is opened. */
export function selectProfile(
  app: Pick<App, "isPackaged" | "getPath" | "setPath"> & {
    commandLine: Pick<App["commandLine"], "hasSwitch">;
  },
): void {
  if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", join(app.getPath("appData"), "Foom Dev"));
  }
}

/** Parent agent credentials must never reach this app's terminals or hooks. */
export function clearParentHooks(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("FOOM_") || key.toUpperCase() === "CLAUDECODE") {
      Reflect.deleteProperty(env, key);
    }
  }
}
