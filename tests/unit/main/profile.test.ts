import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { selectProfile, clearParentHooks } from "../../../src/main/profile";

test.each([false, true])(
  "profile selection preserves explicit directories (packaged: %s)",
  (isPackaged) => {
    for (const explicit of [false, true]) {
      const app = {
        isPackaged,
        commandLine: { hasSwitch: vi.fn(() => explicit) },
        getPath: vi.fn(() => "/app-data"),
        setPath: vi.fn(),
      };
      selectProfile(app);
      if (!isPackaged && !explicit)
        expect(app.setPath).toHaveBeenCalledWith("userData", join("/app-data", "Foom Dev"));
      else expect(app.setPath).not.toHaveBeenCalled();
    }
  },
);

test("removes inherited Foom credentials and Claude nesting guard without changing user configuration", () => {
  const env = {
    FOOM_TOKEN: "secret",
    FOOM_SESSION: "parent",
    FOOM_HOOK_URL: "parent receiver",
    foom_token: "windows",
    CLAUDECODE: "1",
    PATH: "/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "user key",
  };
  clearParentHooks(env);
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/user", ANTHROPIC_API_KEY: "user key" });
});
