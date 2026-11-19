import { viewStream } from "../../../fixtures/view-stream";
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorPresentation } from "../../../../src/renderer/board/error-presentation";
import { useSettingsView } from "../../../../src/renderer/data/view-hooks";
import { useSetupState } from "../../../../src/renderer/preflight/use-setup-state";
import { useSetupSaves } from "../../../../src/renderer/preflight/use-setup-saves";
import { useRepositorySelection } from "../../../../src/renderer/preflight/use-repository-selection";
import { usePreflightNavigation } from "../../../../src/renderer/preflight/use-preflight-navigation";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type { CodeScan, SettingsPatch, SetupState } from "../../../../src/shared/setup";
import { report, setupState } from "../../../fixtures/setup";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(initial = setupState()) {
  let main = initial;
  let listener: ((state: SetupState) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const source = {
    state: vi.fn(() => Promise.resolve(main)),
    save: vi.fn((patch: SettingsPatch) => {
      const { agentArguments, ...settings } = patch;
      main = {
        ...main,
        settings: {
          ...main.settings,
          ...settings,
          agentArguments: { ...main.settings.agentArguments, ...agentArguments },
        },
      };
      return Promise.resolve(main);
    }),
    subscribe: vi.fn((next: (state: SetupState) => void) => {
      listener = next;
      return unsubscribe;
    }),
    scanAgents: vi.fn(() => Promise.resolve(report())),
    changeAgyPlugin: vi.fn(() => Promise.resolve(report())),
    openThemesFolder: vi.fn(() => Promise.resolve()),
    repositories: vi.fn<SetupSource["repositories"]>(() => Promise.resolve([])),
    suggestions: vi.fn(() => Promise.resolve([])),
    scan: vi.fn<SetupSource["scan"]>(() => Promise.resolve(null)),
    apply: vi.fn<SetupSource["apply"]>(() => Promise.resolve({ repositories: [], failures: [] })),
  } satisfies SetupSource;
  return { initial, source, unsubscribe, broadcast: (next: SetupState) => listener?.(next) };
}
const wrapper = ErrorPresentation;
afterEach(cleanup);

function saves(f: ReturnType<typeof fixture>, error = vi.fn()) {
  return renderHook(
    () => {
      const setup = useSetupState(f.source, f.initial);
      return { ...setup, ...useSetupSaves(f.source, setup, error) };
    },
    { wrapper },
  );
}

test("sound overlays stale snapshots, coalesces writes, and releases the overlay after saving", async () => {
  const f = fixture();
  const first = deferred<SetupState>();
  f.source.save.mockImplementationOnce(() => first.promise);
  const { result, unmount } = saves(f);
  const sound = { ...f.initial.settings.sound, workingVolume: 0.2 };
  act(() => {
    result.current.save({ sound });
    result.current.save({ sound: { ...sound, workingVolume: 0.4 } });
    result.current.save({ sound: { ...sound, workingVolume: 0.8 } });
    f.broadcast(setupState({ interfaceScale: 150 }));
  });
  expect(result.current.state.settings.sound.workingVolume).toBe(0.8);
  expect(result.current.state.settings.interfaceScale).toBe(150);
  expect(f.source.save).toHaveBeenCalledTimes(1);
  await act(async () => {
    await Promise.resolve();
    first.resolve(setupState({ sound }));
  });
  expect(f.source.save).toHaveBeenCalledTimes(2);
  expect((await f.source.state()).settings.sound.workingVolume).toBe(0.8);
  act(() => f.broadcast(f.initial));
  expect(result.current.state).toEqual(f.initial);
  unmount();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});

test("unmount submits the last sound edit before a reopened view saves a newer edit", async () => {
  const f = fixture();
  const first = deferred<SetupState>();
  f.source.save.mockImplementationOnce(() => first.promise);
  const view = saves(f);
  act(() => {
    view.result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.2 } });
    view.result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.8 } });
  });
  view.unmount();
  expect(f.source.save).toHaveBeenCalledTimes(2);
  const reopened = saves({ ...f, initial: await f.source.state() });
  await act(async () => {
    await Promise.resolve();
    reopened.result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.6 } });
    first.resolve(setupState({ sound: { ...f.initial.settings.sound, workingVolume: 0.2 } }));
  });
  expect(f.source.save).toHaveBeenCalledTimes(3);
  expect((await f.source.state()).settings.sound.workingVolume).toBe(0.6);
  expect(reopened.result.current.state.settings.sound.workingVolume).toBe(0.6);
});

test("failed saves restore main state and permit later writes even when refresh fails", async () => {
  const f = fixture();
  const error = vi.fn();
  const { result } = saves(f, error);
  f.source.save.mockRejectedValueOnce(Error("Disk full"));
  await act(async () => {
    await Promise.resolve();
    result.current.save({ interfaceScale: 150 });
  });
  expect(error).toHaveBeenCalledWith("Unable to update settings.");
  expect(result.current.state).toEqual(f.initial);
  f.source.save.mockRejectedValueOnce(Error("Offline"));
  f.source.state.mockRejectedValueOnce(Error("Offline"));
  await act(async () => {
    await Promise.resolve();
    result.current.save({ interfaceScale: 120 });
  });
  f.source.save.mockRejectedValueOnce(Error("Disk full"));
  await act(async () => {
    await Promise.resolve();
    result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.8 } });
  });
  expect(result.current.state).toEqual(f.initial);
  f.source.save.mockRejectedValueOnce(Error("Offline"));
  f.source.state.mockRejectedValueOnce(Error("Offline"));
  await act(async () => {
    await Promise.resolve();
    result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.7 } });
  });
  await act(async () => {
    await Promise.resolve();
    result.current.save({ sound: { ...f.initial.settings.sound, workingVolume: 0.6 } });
  });
  expect(result.current.state.settings.sound.workingVolume).toBe(0.6);
});

test("argument writes send only the edited provider in sequence, including when another list is masked", async () => {
  const f = fixture(setupState({ agentArguments: { fixture: [] } }));
  const first = deferred<SetupState>();
  const persist = f.source.save.getMockImplementation();
  if (!persist) throw Error("Missing fixture persistence");
  let committed = f.initial;
  f.source.save.mockImplementationOnce(async (patch) => {
    committed = await persist(patch);
    return first.promise;
  });
  const { result } = saves(f);
  const a = result.current.saveArguments("claude", ["--verbose"]);
  const b = result.current.saveArguments("codex", ["--search"]);
  await waitFor(() => {
    expect(f.source.save).toHaveBeenCalledTimes(1);
  });
  expect(f.source.save).toHaveBeenCalledWith({ agentArguments: { claude: ["--verbose"] } });
  await act(async () => {
    await Promise.resolve();
    first.resolve(committed);
    await Promise.all([a, b]);
  });
  expect(f.source.save).toHaveBeenLastCalledWith({
    agentArguments: { codex: ["--search"] },
  });
  f.source.save.mockRejectedValueOnce(Error("Offline"));
  await expect(result.current.saveArguments("claude", [])).rejects.toThrow("Offline");
  await act(async () => result.current.saveArguments("agy", ["--verbose"]));
  expect(f.source.save).toHaveBeenLastCalledWith({
    agentArguments: { agy: ["--verbose"] },
  });
});

const scan: CodeScan = {
  folder: "/code",
  folders: 2,
  truncated: false,
  repositories: [
    {
      path: "/code/recent",
      name: "recent",
      relative: "recent",
      branch: "main",
      lastActive: 1,
      recent: true,
      added: false,
    },
    {
      path: "/code/added",
      name: "added",
      relative: "added",
      branch: "main",
      lastActive: 0,
      recent: false,
      added: true,
    },
  ],
};
const registered = [{ path: "/code/added", name: "added" }];
function repositories(
  f: ReturnType<typeof fixture>,
  settingsMode = false,
  initialSection?: "config",
) {
  const error = vi.fn();
  const hook = renderHook(
    () => {
      const selection = useRepositorySelection(f.source, settingsMode, error);
      return {
        ...selection,
        ...usePreflightNavigation(
          settingsMode,
          initialSection,
          settingsMode,
          "/code",
          selection,
          error,
        ),
      };
    },
    { wrapper },
  );
  return { ...hook, error };
}

test.each([false, true])(
  "scan selection and save timing preserve settingsMode=%s",
  async (settingsMode) => {
    const f = fixture();
    f.source.repositories.mockResolvedValue(registered);
    f.source.scan.mockImplementation((_id, _folder, progress) => {
      progress({ folders: 2, repositories: 2 });
      return Promise.resolve(scan);
    });
    const { result } = repositories(f, settingsMode);
    expect(result.current.step).toBe(settingsMode ? 11 : 0);
    await act(async () => {
      await Promise.resolve();
      result.current.go(2);
    });
    expect(result.current.code?.selected).toEqual(
      new Set(settingsMode ? ["/code/added"] : ["/code/recent", "/code/added"]),
    );
    expect(result.current.codeScanning).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
      result.current.selectRepositories({ scan, selected: new Set(["/code/recent"]) });
    });
    expect(f.source.apply).toHaveBeenCalledTimes(settingsMode ? 1 : 0);
    await act(async () => {
      await Promise.resolve();
      result.current.go(3);
    });
    expect(result.current.step).toBe(3);
    expect(result.current.reached).toBe(3);
    expect(f.source.apply).toHaveBeenCalledWith(["/code/recent"]);
  },
);

test("repository refusal holds navigation; Git-only refusal can reach readiness", async () => {
  const f = fixture();
  f.source.scan.mockResolvedValue(scan);
  const refused = deferred<Awaited<ReturnType<SetupSource["apply"]>>>();
  f.source.apply.mockImplementationOnce(() => refused.promise);
  const { result, error } = repositories(f);
  await act(async () => {
    await Promise.resolve();
    result.current.go(2);
  });
  act(() => {
    result.current.go(3);
  });
  expect(result.current.applying).toBe(true);
  expect(result.current.step).toBe(2);
  await act(async () => {
    await Promise.resolve();
    refused.resolve({
      repositories: registered,
      failures: [{ path: "/code/recent", message: "Has worktrees" }],
    });
  });
  expect(result.current.step).toBe(2);
  expect(result.current.applying).toBe(false);
  expect(error).toHaveBeenLastCalledWith("Unable to update repositories.");
  f.source.apply.mockResolvedValueOnce({
    repositories: registered,
    failures: [
      {
        path: "/code/recent",
        message: "Git is unavailable. Install Git and recheck on Go / no-go.",
      },
    ],
  });
  await act(async () => {
    await Promise.resolve();
    result.current.go(3);
  });
  expect(result.current.step).toBe(3);
});

test("Settings restores registered selection on refusal and on a rejected apply", async () => {
  const f = fixture();
  f.source.repositories.mockResolvedValue(registered);
  f.source.scan.mockResolvedValue(scan);
  const { result, error } = repositories(f, true, "config");
  expect(result.current.step).toBe(9);
  await act(async () => {
    await Promise.resolve();
    result.current.go(2);
  });
  const selection = { scan, selected: new Set(["/code/recent"]) };
  f.source.apply.mockResolvedValueOnce({
    repositories: registered,
    failures: [{ path: "/code/recent", message: "Refused" }],
  });
  await act(async () => {
    await Promise.resolve();
    result.current.selectRepositories(selection);
  });
  expect(result.current.code?.selected).toEqual(new Set(["/code/added"]));
  f.source.apply.mockRejectedValueOnce(Error("Offline"));
  await act(async () => {
    await Promise.resolve();
    result.current.selectRepositories(selection);
  });
  expect(result.current.code?.selected).toEqual(new Set(["/code/added"]));
  expect(error).toHaveBeenLastCalledWith("Unable to update settings.");
});

test("cancelled and failed scans retain selection; leaving an unchanged step does not apply", async () => {
  const f = fixture();
  f.source.scan.mockResolvedValueOnce(scan);
  const { result, error } = repositories(f);
  await act(async () => {
    await Promise.resolve();
    result.current.go(2);
  });
  const selection = result.current.code;
  await act(async () => {
    await Promise.resolve();
    result.current.scanCode(null);
  });
  expect(result.current.code).toBe(selection);
  f.source.scan.mockRejectedValueOnce(Error("Scan failed"));
  await act(async () => {
    await Promise.resolve();
    result.current.scanCode("/other");
  });
  expect(result.current.code).toBe(selection);
  expect(result.current.codeScanning).toBeUndefined();
  expect(error).toHaveBeenLastCalledWith("Unable to update settings.");
  act(() => {
    result.current.go(2);
  });
  expect(f.source.apply).not.toHaveBeenCalled();
});

test("repository load failures and disposed reads never replace a later view", async () => {
  const f = fixture();
  const loading = deferred<Awaited<ReturnType<SetupSource["repositories"]>>>();
  f.source.repositories.mockImplementationOnce(() => loading.promise);
  const first = repositories(f);
  first.unmount();
  await act(async () => {
    await Promise.resolve();
    loading.resolve(registered);
  });
  f.source.repositories.mockRejectedValueOnce(Error("Offline"));
  const second = repositories(f);
  await act(async () => {
    await Promise.resolve();
  });
  expect(second.result.current.repositories).toEqual([]);
  const failed = deferred<Awaited<ReturnType<SetupSource["repositories"]>>>();
  f.source.repositories.mockImplementationOnce(() => failed.promise);
  const third = repositories(f);
  third.unmount();
  await act(async () => {
    await Promise.resolve();
    failed.reject(Error("Offline"));
  });
});

test("live Sound edits remain local drafts across stale pushes and command replies", async () => {
  const f = fixture();
  const stream = viewStream(f.initial);
  Object.assign(f.source, { views: stream.api });
  const first = deferred<SetupState>();
  f.source.save.mockImplementationOnce(() => first.promise);
  const view = saves(f);
  await act(async () => {
    await Promise.resolve();
  });
  const sound = { ...f.initial.settings.sound, workingVolume: 0.8 };
  act(() => {
    view.result.current.save({ sound });
    stream.data.settings = setupState({ interfaceScale: 150 });
    stream.push("settings");
    view.result.current.receiveState(stream.data.settings);
  });
  expect(view.result.current.state.settings.sound.workingVolume).toBe(0.8);
  expect(view.result.current.state.settings.interfaceScale).toBe(150);
  await act(async () => {
    view.result.current.save({ showNewChildren: false });
    await Promise.resolve();
  });
  expect(view.result.current.state.settings.sound.workingVolume).toBe(0.8);
  expect(view.result.current.state.settings.showNewChildren).toBe(
    f.initial.settings.showNewChildren,
  );
  act(() => {
    view.result.current.setState({
      ...stream.data.settings,
      settings: { ...stream.data.settings.settings, sound },
    });
  });
  await act(async () => {
    stream.data.settings = setupState({ interfaceScale: 150, sound });
    stream.push("settings");
    first.resolve(stream.data.settings);
    await Promise.resolve();
  });
  expect(view.result.current.state.settings.sound.workingVolume).toBe(0.8);
  // A failed later edit clears only its draft; the pushed main snapshot wins.
  f.source.save.mockRejectedValueOnce(new Error("fixture write failure"));
  await act(async () => {
    view.result.current.save({ sound: { ...sound, workingVolume: 0.2 } });
    await Promise.resolve();
  });
  expect(view.result.current.state.settings.sound.workingVolume).toBe(0.8);
  act(() => {
    stream.errors.add("settings");
    stream.push("settings");
  });
  await waitFor(() => {
    expect(view.result.current.error).toBe(true);
  });
  view.unmount();
  expect(f.source.subscribe).not.toHaveBeenCalled();
});

test("live preference previews stay local, preserve newer intent across reordered replies and release to pushed truth", async () => {
  const f = fixture();
  const stream = viewStream(f.initial);
  Object.assign(f.source, { views: stream.api });
  const first = deferred<SetupState>();
  const second = deferred<SetupState>();
  f.source.save
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const view = saves(f);
  const observer = renderHook(() => useSettingsView({ views: stream.api }, f.source.state));
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.result.current.save({ panelColor: "subtle" });
    view.result.current.save({ panelColor: "plain" });
    stream.data.settings = setupState({ interfaceScale: 150 });
    stream.push("settings");
  });
  expect(view.result.current.state.settings.panelColor).toBe("plain");
  expect(observer.result.current.data?.settings.panelColor).toBe("vivid");
  expect(view.result.current.state.settings.interfaceScale).toBe(150);
  await act(async () => {
    second.resolve(setupState({ panelColor: "plain" }));
    await second.promise;
  });
  expect(view.result.current.state.settings.panelColor).toBe("plain");
  act(() => {
    stream.data.settings = setupState({ panelColor: "vivid", interfaceScale: 120 });
    stream.push("settings");
  });
  await act(async () => {
    first.resolve(setupState({ panelColor: "subtle" }));
    await first.promise;
  });
  expect(view.result.current.state.settings.panelColor).toBe("vivid");
  expect(view.result.current.state.settings.interfaceScale).toBe(120);
});

test("a refused live preference command releases its local preview to the latest pushed settings", async () => {
  const f = fixture();
  const stream = viewStream(f.initial);
  Object.assign(f.source, { views: stream.api });
  const reply = deferred<SetupState>();
  f.source.save.mockImplementationOnce(() => reply.promise);
  const error = vi.fn();
  const view = saves(f, error);
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.result.current.save({ hooks: false });
  });
  expect(view.result.current.state.settings.hooks).toBe(false);
  await act(async () => {
    reply.reject(new Error("Refused"));
    await Promise.resolve();
  });
  expect(error).toHaveBeenCalledWith("Unable to update settings.");
  expect(view.result.current.state.settings.hooks).toBe(f.initial.settings.hooks);
});
