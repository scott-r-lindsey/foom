import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { selectProfile, clearParentHooks, stateRoot } from "../../../src/main/profile";

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

test.each([false, true])(
  "isolated development state stays in the profile (packaged: %s)",
  (isPackaged) => {
    const app = {
      isPackaged,
      getPath: (name: string) => (name === "home" ? "/fixture-home" : "/temporary-profile"),
      commandLine: { hasSwitch: () => true, getSwitchValue: () => "" },
    };
    expect(stateRoot(app)).toBe(join(isPackaged ? "/fixture-home" : "/temporary-profile", ".foom"));
    app.commandLine.getSwitchValue = () => "/untrusted-path";
    if (isPackaged) expect(stateRoot(app)).toBe(join("/fixture-home", ".foom"));
    else expect(() => stateRoot(app)).toThrow("does not accept a value");
    app.commandLine.hasSwitch = () => false;
    expect(stateRoot(app)).toBe(join("/fixture-home", ".foom"));
  },
);
