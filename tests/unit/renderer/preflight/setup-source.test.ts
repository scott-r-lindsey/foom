// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createSetupSource } from "../../../../src/renderer/preflight/setup-source";

test("preflight reaches main only through the setup bridge", async () => {
  const repository = { path: "/code/app", name: "app" };
  const desktop = {
    hosts: vi.fn(() => Promise.resolve({ hosts: [], locations: [] })),
    checkReadiness: vi.fn(() => Promise.resolve("readiness")),
    listTerminalFonts: vi.fn(() => Promise.resolve(["Mono"])),
    openThemesFolder: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => {}),
    setupState: vi.fn(() => Promise.resolve("state")),
    saveSetup: vi.fn(() => Promise.resolve("saved")),
    onSetupChange: vi.fn(() => "off"),
    codeSuggestions: vi.fn(() => Promise.resolve(["/code"])),
    scanCode: vi.fn(() => Promise.resolve("scan")),
    applyRepositories: vi.fn(() => Promise.resolve("applied")),
    changeAgentSetup: vi.fn(() => Promise.resolve("plugin")),
    changeAgyPlugin: vi.fn(() => Promise.resolve("plugin")),
    scanAgents: vi.fn(() => Promise.resolve("scan")),
    workspace: vi.fn(() => Promise.resolve({ repositories: [repository], terminals: [] })),
    environmentState: vi.fn(() => Promise.resolve("env")),
    saveEnvironment: vi.fn(() => Promise.resolve("env")),
    removeEnvironment: vi.fn(() => Promise.resolve("env")),
    readShellEnvironment: vi.fn(() => Promise.resolve([])),
    importEnvironment: vi.fn(() => Promise.resolve("env")),
  };
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
  const source = createSetupSource();
  await expect(source.hosts?.({ action: "list" })).resolves.toEqual({ hosts: [], locations: [] });
  await source.restartToUpdate?.();
  expect(desktop.restartToUpdate).toHaveBeenCalledOnce();
  await expect(source.checkReadiness?.()).resolves.toBe("readiness");
  await expect(source.listTerminalFonts?.()).resolves.toEqual(["Mono"]);
  await source.listTerminalFonts?.(true);
  expect(desktop.listTerminalFonts).toHaveBeenLastCalledWith(true);
  await source.openThemesFolder("theme");
  expect(desktop.openThemesFolder).toHaveBeenCalledWith("theme");
  await expect(source.state()).resolves.toBe("state");
  await expect(source.save({ hooks: false })).resolves.toBe("saved");
  const listener = vi.fn();
  expect(source.subscribe(listener)).toBe("off");
  expect(desktop.onSetupChange).toHaveBeenCalledWith(listener);
  await expect(source.suggestions()).resolves.toEqual(["/code"]);
  const onProgress = vi.fn();
  await expect(source.scan("s1", null, onProgress)).resolves.toBe("scan");
  expect(desktop.scanCode).toHaveBeenCalledWith("s1", null, onProgress);
  await expect(source.apply(["/code/a"])).resolves.toBe("applied");
  expect(desktop.applyRepositories).toHaveBeenCalledWith(["/code/a"]);
  await expect(source.changeAgentSetup?.("fixture", "install")).resolves.toBe("plugin");
  expect(desktop.changeAgentSetup).toHaveBeenCalledWith("fixture", "install");
  await expect(source.changeAgyPlugin("install")).resolves.toBe("plugin");
  expect(desktop.changeAgyPlugin).toHaveBeenCalledWith("install");
  await expect(source.scanAgents(true)).resolves.toBe("scan");
  await expect(source.repositories()).resolves.toEqual([repository]);
  expect(desktop.saveSetup).toHaveBeenCalledWith({ hooks: false });
  expect(desktop.scanAgents).toHaveBeenCalledWith(true);
  await expect(source.scanAgents(true, "claude")).resolves.toBe("scan");
  expect(desktop.scanAgents).toHaveBeenLastCalledWith(true, "claude");
  const environment = source.environment;
  if (!environment) throw new Error("Missing environment");
  const change = { scope: "all", previous: null, name: "A", value: "1", secret: false } as const;
  await environment.environmentState();
  await environment.saveEnvironment(change);
  await environment.removeEnvironment("codex", "A");
  await environment.readShellEnvironment();
  await environment.importEnvironment(["HTTPS_PROXY"]);
  expect(desktop.saveEnvironment).toHaveBeenCalledWith(change);
  expect(desktop.removeEnvironment).toHaveBeenCalledWith("codex", "A");
  expect(desktop.importEnvironment).toHaveBeenCalledWith(["HTTPS_PROXY"]);
  expect(desktop.environmentState).toHaveBeenCalledOnce();
  expect(desktop.readShellEnvironment).toHaveBeenCalledOnce();
});

test("Foom config reaches main only through the config bridge", async () => {
  const desktop = {
    configStatus: vi.fn(() => Promise.resolve("status")),
    decideConfig: vi.fn(() => Promise.resolve("decided")),
    openConfigFolder: vi.fn(async () => {}),
    onConfigChange: vi.fn(() => "off"),
  };
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
  const config = createSetupSource().config;
  if (!config) throw new Error("Expected config source");
  await expect(config.status()).resolves.toBe("status");
  await expect(config.decide("keep", "f".repeat(64))).resolves.toBe("decided");
  expect(desktop.decideConfig).toHaveBeenCalledWith("keep", "f".repeat(64));
  await config.openFolder();
  expect(desktop.openConfigFolder).toHaveBeenCalled();
  const listener = vi.fn();
  expect(config.subscribe(listener)).toBe("off");
  expect(desktop.onConfigChange).toHaveBeenCalledWith(listener);
});

test("host recipe observations discard stale reads and release subscriptions", async () => {
  const view = vi.fn();
  const off = vi.fn();
  let changed = () => {};
  const workspace = vi
    .fn()
    .mockResolvedValue({ terminals: [{ id: "recipe", exited: true, exitCode: 0 }] });
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workspace,
      onExit: () => () => {},
      onWorkspaceChange: (listener: () => void) => {
        changed = listener;
        return off;
      },
    },
  });
  const source = createSetupSource(view);
  source.hostTerminal?.createView();
  expect(view).toHaveBeenCalledOnce();
  const listener = vi.fn();
  const dispose = source.hostTerminal?.observe("recipe", listener);
  await vi.waitFor(() => {
    expect(listener).toHaveBeenCalledWith({ exited: true, code: 0 });
  });
  workspace.mockResolvedValue({ terminals: [{ id: "recipe" }] });
  changed();
  await vi.waitFor(() => {
    expect(listener).toHaveBeenCalledWith({ exited: false });
  });
  listener.mockClear();
  changed();
  changed();
  dispose?.();
  await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
  expect(off).toHaveBeenCalledOnce();
});

test("recipe exit events win over earlier workspace reads", async () => {
  let exit = (_id: string, _code: number) => {};
  const off = vi.fn();
  let resolve: (value: unknown) => void = () => {};
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workspace: () =>
        new Promise((done) => {
          resolve = done;
        }),
      onWorkspaceChange: () => () => {},
      onExit: (listener: typeof exit) => {
        exit = listener;
        return off;
      },
    },
  });
  const listener = vi.fn();
  const dispose = createSetupSource().hostTerminal?.observe("recipe", listener);
  exit("other", 1);
  expect(listener).not.toHaveBeenCalled();
  exit("recipe", 17);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ exited: true, code: 17 });
  resolve({ terminals: [{ id: "recipe", exited: false }] });
  await Promise.resolve();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledOnce();
  dispose?.();
  expect(off).toHaveBeenCalledOnce();
});

test("Settings tracks only its installs, waits for launch and disposes running or exited sessions", async () => {
  let resolve = (_value: { hosts: []; locations: []; recipeSession: string }) => {};
  const hosts = vi.fn(
    () =>
      new Promise<{ hosts: []; locations: []; recipeSession: string }>((done) => {
        resolve = done;
      }),
  );
  const workspace = vi
    .fn()
    .mockResolvedValue({ terminals: [{ id: "install" }, { id: "sign-in" }] });
  const kill = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { hosts, workspace, kill, onExit: () => () => {} },
  });
  const source = createSetupSource();
  const installs = source.installs;
  if (!installs || !source.hosts) throw new Error("Missing install owner");
  expect(installs.hasSessions()).toBe(false);
  const action = { action: "recipe", host: "cloud", tool: "git", operation: "install" } as const;
  const launch = source.hosts(action);
  expect(installs.hasSessions()).toBe(true);
  const running = installs.running();
  resolve({ hosts: [], locations: [], recipeSession: "install" });
  await launch;
  await expect(running).resolves.toBe(true);
  expect(installs.sessions()).toEqual(new Map([["cloud", "install"]]));
  workspace.mockResolvedValue({ terminals: [{ id: "install", exited: true }, { id: "sign-in" }] });
  await expect(installs.running()).resolves.toBe(false);
  await installs.close();
  expect(kill).toHaveBeenCalledExactlyOnceWith("install");
  expect(installs.hasSessions()).toBe(false);
  const signIn = source.hosts({
    action: "recipe",
    host: "cloud",
    tool: "codex",
    operation: "sign-in",
  });
  resolve({ hosts: [], locations: [], recipeSession: "sign-in" });
  await signIn;
  expect(installs.hasSessions()).toBe(false);
});

test("Settings close waits for pending installs, refuses a new install while closing and retries failures", async () => {
  let resolve = (_value: { hosts: []; locations: []; recipeSession?: string }) => {};
  const hosts = vi.fn(
    () =>
      new Promise<{ hosts: []; locations: []; recipeSession?: string }>((done) => {
        resolve = done;
      }),
  );
  const workspace = vi.fn().mockResolvedValue({ terminals: [{ id: "install" }] });
  const kill = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { hosts, workspace, kill, onExit: () => () => {} },
  });
  const source = createSetupSource();
  const installs = source.installs;
  if (!installs || !source.hosts) throw new Error("Missing install owner");
  const action = { action: "recipe", host: "cloud", tool: "git", operation: "install" } as const;
  const launch = source.hosts(action);
  const close = installs.close();
  await expect(source.hosts(action)).rejects.toThrow("Settings is closing");
  expect(kill).not.toHaveBeenCalled();
  resolve({ hosts: [], locations: [], recipeSession: "install" });
  await launch;
  await close;
  expect(kill).toHaveBeenCalledExactlyOnceWith("install");
  const next = source.hosts(action);
  resolve({ hosts: [], locations: [], recipeSession: "install" });
  await next;
  kill.mockRejectedValueOnce(new Error("unreachable"));
  await expect(installs.close()).rejects.toThrow("unreachable");
  expect(installs.hasSessions()).toBe(true);
  workspace.mockResolvedValue({ terminals: [] });
  await installs.close();
  expect(installs.hasSessions()).toBe(false);
  const unavailable = source.hosts(action);
  resolve({ hosts: [], locations: [] });
  await unavailable;
  expect(installs.hasSessions()).toBe(false);
});

test("a new install invalidates an older exit check and closing reconciles through its source", async () => {
  let read = (_value: { terminals: { id: string; exited?: boolean }[] }) => {};
  const workspace = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          read = done;
        }),
    )
    .mockResolvedValue({ terminals: [{ id: "first", exited: true }, { id: "second" }] });
  const hosts = vi
    .fn()
    .mockResolvedValueOnce({ hosts: [], locations: [], recipeSession: "first" })
    .mockResolvedValueOnce({ hosts: [], locations: [], recipeSession: "second" });
  const close = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { hosts, workspace, onExit: () => () => {} },
  });
  const source = createSetupSource(undefined, close);
  if (!source.installs || !source.hosts) throw new Error("Missing install owner");
  const action = {
    action: "recipe",
    host: "first-host",
    tool: "git",
    operation: "install",
  } as const;
  await source.hosts(action);
  const running = source.installs.running();
  await vi.waitFor(() => {
    expect(workspace).toHaveBeenCalledOnce();
  });
  await source.hosts({ ...action, host: "second-host" });
  read({ terminals: [{ id: "first", exited: true }] });
  await expect(running).resolves.toBe(true);
  expect(workspace).toHaveBeenCalledTimes(2);
  await source.installs.close();
  expect(close.mock.calls).toEqual([["first"], ["second"]]);
  expect(source.installs.hasSessions()).toBe(false);
});

test("native install exits override delayed workspace metadata, including exits before the reply", async () => {
  let exit = (_id: string, _code: number) => {};
  const off = vi.fn();
  const workspace = vi.fn().mockResolvedValue({ terminals: [{ id: "early" }, { id: "live" }] });
  const hosts = vi
    .fn()
    .mockImplementationOnce(() => {
      for (let i = 0; i < 260; i++) exit(`unrelated-${String(i)}`, 0);
      exit("early", 0);
      return Promise.resolve({ hosts: [], locations: [], recipeSession: "early" });
    })
    .mockResolvedValueOnce({ hosts: [], locations: [], recipeSession: "live" })
    .mockRejectedValueOnce(new Error("launch failed"));
  const kill = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      hosts,
      workspace,
      kill,
      onExit: (listener: typeof exit) => {
        exit = listener;
        return off;
      },
    },
  });
  const source = createSetupSource();
  if (!source.installs || !source.hosts) throw new Error("Missing install owner");
  const action = { action: "recipe", host: "cloud", tool: "git", operation: "install" } as const;
  await source.hosts(action);
  await expect(source.installs.running()).resolves.toBe(false);
  await source.hosts(action);
  await expect(source.installs.running()).resolves.toBe(true);
  exit("live", 0);
  await expect(source.installs.running()).resolves.toBe(false);
  await source.installs.close();
  expect(off).toHaveBeenCalledOnce();
  await expect(source.hosts(action)).rejects.toThrow("launch failed");
  expect(source.installs.hasSessions()).toBe(false);
  expect(off).toHaveBeenCalledTimes(2);
  source.installs.dispose();
});

test("local installs share Settings ownership and cannot escape Stop/Keep open", async () => {
  const localAgentInstall = vi.fn((id?: string) =>
    Promise.resolve({ available: ["claude"], ...(id ? { recipeSession: "local-install" } : {}) }),
  );
  const kill = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      localAgentInstall,
      kill,
      workspace: () => Promise.resolve({ terminals: [{ id: "local-install" }] }),
      onExit: () => () => {},
    },
  });
  const source = createSetupSource();
  await source.localAgentInstall?.();
  expect(source.installs?.hasSessions()).toBe(false);
  await source.localAgentInstall?.("claude");
  expect(source.installs?.sessions()).toEqual(new Map([["local:claude", "local-install"]]));
  await expect(source.installs?.running()).resolves.toBe(true);
  await source.installs?.close();
  expect(kill).toHaveBeenCalledExactlyOnceWith("local-install");
});

test("gh embedded recipes retain sign-in metadata across section changes and share exit ownership", async () => {
  const hosts = vi.fn().mockResolvedValue({ hosts: [], locations: [], recipeSession: "gh-device" });
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      hosts,
      onExit: () => () => {},
      workspace: () => Promise.resolve({ terminals: [{ id: "gh-device", exited: true }] }),
      kill: vi.fn(() => Promise.resolve()),
      githubSignIn: vi.fn(() => Promise.resolve({ phase: "waiting", copied: true, opened: true })),
    },
  });
  const source = createSetupSource();
  await source.hosts?.({
    action: "recipe",
    host: "cloud",
    tool: "gh",
    operation: "install-sign-in",
  });
  expect(source.githubSignInSessions?.()).toEqual(new Map([["gh-device", true]]));
  expect(source.installs?.hasSessions()).toBe(true);
  await source.githubSignIn?.("gh-device", "read");
  await source.installs?.close();
  expect(source.githubSignInSessions?.().size).toBe(0);
  await source.hosts?.({ action: "recipe", host: "cloud", tool: "gh", operation: "sign-in" });
  expect(source.githubSignInSessions?.()).toEqual(new Map([["gh-device", false]]));
  await source.installs?.close();
});
