import type * as Os from "node:os";
import { expect, test, vi } from "vitest";
const account = vi.hoisted(() => ({
  username: "fixture-user",
  shell: "/fixture/login-shell" as string | null,
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof Os>()),
  userInfo: () => account,
  tmpdir: () => "/fixture/tmp",
}));
import { installerEnvironment } from "../../../src/node-common/vendor-install";

test("complete account defaults survive an otherwise empty replacement environment", () => {
  expect(installerEnvironment("/fixture/home", {})).toEqual({
    HOME: "/fixture/home",
    USER: "fixture-user",
    LOGNAME: "fixture-user",
    SHELL: "/fixture/login-shell",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/fixture/tmp",
    LANG: "C",
  });
  account.shell = null;
  expect(installerEnvironment("/fixture/home", { SHELL: "", PATH: "", LANG: "" })["SHELL"]).toBe(
    "/bin/sh",
  );
  account.shell = "/fixture/login-shell";
});

test("login PATH, locale and standard config directories survive without credentials", () => {
  const result = installerEnvironment(
    "/fixture/home",
    {
      HOME: "/wrong",
      USER: "wrong",
      LOGNAME: "wrong",
      SHELL: "/fixture/zsh",
      PATH: "/inherited/bin",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      XDG_BIN_HOME: "/fixture/bin",
      XDG_CONFIG_HOME: "/fixture/config",
      XDG_CACHE_HOME: "/fixture/cache",
      XDG_DATA_HOME: "/fixture/data",
      XDG_STATE_HOME: "/fixture/state",
      XDG_RUNTIME_DIR: "/fixture/run",
      ZDOTDIR: "/fixture/zsh-config",
      FOOM_TOKEN: "secret",
      foom_token: "secret",
      FOOM_SETTINGS_INSTALL: "1",
      CODEX_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      SSH_AUTH_SOCK: "/secret/socket",
      XDG_SESSION_COOKIE: "secret",
      NODE_OPTIONS: "untrusted",
      BASH_ENV: "/untrusted",
      EMPTY: undefined,
    },
    "/login/bin",
  );
  expect(result).toEqual({
    HOME: "/fixture/home",
    USER: "fixture-user",
    LOGNAME: "fixture-user",
    SHELL: "/fixture/zsh",
    PATH: "/login/bin",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    XDG_BIN_HOME: "/fixture/bin",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_CACHE_HOME: "/fixture/cache",
    XDG_DATA_HOME: "/fixture/data",
    XDG_STATE_HOME: "/fixture/state",
    XDG_RUNTIME_DIR: "/fixture/run",
    ZDOTDIR: "/fixture/zsh-config",
  });
});
