import {
  ErrorPresentation,
  BackgroundErrorMark,
} from "../../../../src/renderer/board/error-presentation";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { message } from "../../../../src/renderer/preflight/message";
import { RepositoriesStep } from "../../../../src/renderer/preflight/repositories-step";
import { Preflight } from "../../../../src/renderer/preflight/preflight-view";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type {
  CodeScan,
  CodeSuggestion,
  RepositoryUpdate,
  ScanProgress,
  SettingsPatch,
  SetupState,
} from "../../../../src/shared/setup";
import type { AgentReport } from "../../../../src/shared/workspace";
import type { Repository } from "../../../../src/shared/worktrees";
import { installation, report, setupState } from "../../../fixtures/setup";

vi.mock("../../../../src/renderer/preflight/scale-preflight", () => ({ scalePreflight: vi.fn() }));

vi.mock("../../../../src/renderer/preflight/center-step", () => ({ centerStep: vi.fn() }));

const all = report(installation("claude"), installation("codex"), installation("agy"));
let changed: ((state: SetupState) => void) | undefined;
const codeScan: CodeScan = {
  folder: "/home/me/code",
  folders: 3,
  truncated: false,
  repositories: [
    {
      path: "/home/me/code/app",
      name: "app",
      relative: "app",
      branch: "main",
      lastActive: Date.now() - 3_600_000,
      recent: true,
      added: false,
    },
    {
      path: "/home/me/code/old",
      name: "old",
      relative: "old",
      branch: null,
      lastActive: Date.now() - 90 * 86_400_000,
      recent: false,
      added: false,
    },
  ],
};
function fake(initial: SetupState, scan: AgentReport = all) {
  let state = initial;
  const repositories: Repository[] = [];
  const update = (next: SetupState) => {
    state = next;
    return Promise.resolve(state);
  };
  return {
    openThemesFolder: vi.fn(async () => {}),
    state: vi.fn(() => Promise.resolve(state)),
    save: vi.fn((patch: SettingsPatch) =>
      update({ ...state, settings: { ...state.settings, ...patch } }),
    ),
    changeAgyPlugin: vi.fn(() => Promise.resolve(scan)),
    scanAgents: vi.fn((_refresh: boolean) => Promise.resolve(scan)),
    repositories: vi.fn(() => Promise.resolve([...repositories])),
    subscribe: vi.fn((listener: (next: SetupState) => void) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    }),
    suggestions: vi.fn(() =>
      Promise.resolve<readonly CodeSuggestion[]>([
        { path: "/home/me/code", repositories: 2, more: false },
      ]),
    ),
    scan: vi.fn(
      (_id: string, _folder: string | null, onProgress: (progress: ScanProgress) => void) => {
        onProgress({ folders: 3, repositories: 2 });
        return Promise.resolve<CodeScan | null>(codeScan);
      },
    ),
    apply: vi.fn((selected: readonly string[]) => {
      const scanned = new Set(codeScan.repositories.map((repo) => repo.path));
      const kept = repositories.filter((repo) => !scanned.has(repo.path));
      repositories.splice(
        0,
        repositories.length,
        ...kept,
        ...codeScan.repositories
          .filter((repo) => selected.includes(repo.path))
          .map(({ path, name }) => ({ path, name })),
      );
      return Promise.resolve<RepositoryUpdate>({ repositories: [...repositories], failures: [] });
    }),
  } satisfies SetupSource;
}

function button(name: string | RegExp) {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sounds: {
        list: () => Promise.resolve([]),
        read: () => Promise.resolve({ error: "unavailable" }),
        onChange: () => () => {},
        openFolder: async () => {},
        notices: () => Promise.resolve(""),
      },
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});
afterEach(() => {
  cleanup();
});

test.each([
  ["Working volume", "workingVolume"],
  ["Alert volume", "alertVolume"],
] as const)("%s keeps the latest edit through save replies and broadcasts", async (label, key) => {
  const initial = setupState({ setupComplete: true });
  const source = fake(initial);
  const writes: { state: SetupState; resolve: (state: SetupState) => void }[] = [];
  source.save.mockImplementation(
    (patch) =>
      new Promise<SetupState>((resolve) => {
        writes.push({ state: setupState({ ...initial.settings, ...patch }), resolve });
      }),
  );
  render(<Preflight source={source} initial={initial} settingsMode onLaunched={vi.fn()} />);
  fireEvent.click(button("Sound"));
  const slider = screen.getByLabelText(label);
  for (const value of ["20", "40", "80"]) fireEvent.change(slider, { target: { value } });
  expect(slider).toHaveProperty("value", "80");
  const first = writes[0];
  if (!first) throw Error("Missing first save");
  act(() =>
    changed?.({ ...first.state, settings: { ...first.state.settings, interfaceScale: 150 } }),
  );
  expect(slider).toHaveProperty("value", "80");
  expect(source.save).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.resolve(first.state);
    await Promise.resolve();
  });
  expect(slider).toHaveProperty("value", "80");
  expect(source.save).toHaveBeenCalledTimes(2);
  expect(source.save).toHaveBeenLastCalledWith({
    sound: { ...initial.settings.sound, [key]: 0.8 },
  });
  const last = writes[1];
  if (!last) throw Error("Missing final save");
  await act(async () => {
    changed?.(last.state);
    last.resolve(last.state);
    await Promise.resolve();
  });
  expect(slider).toHaveProperty("value", "80");
  act(() => changed?.(setupState({ sound: { ...initial.settings.sound, [key]: 0.3 } })));
  expect(slider).toHaveProperty("value", "30");
});

test("sound saves preserve later edits after failure and finish after Settings closes", async () => {
  const initial = setupState({ setupComplete: true });
  const source = fake(initial);
  let reject: (error: Error) => void = () => {};
  source.save.mockImplementationOnce(
    () =>
      new Promise<SetupState>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const view = render(
    <Preflight source={source} initial={initial} settingsMode onLaunched={vi.fn()} />,
  );
  fireEvent.click(button("Sound"));
  const slider = screen.getByLabelText("Working volume");
  fireEvent.change(slider, { target: { value: "20" } });
  fireEvent.change(slider, { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("Alert volume"), { target: { value: "60" } });
  fireEvent.click(screen.getByLabelText("Alerts on"));
  view.unmount();
  await act(async () => {
    reject(Error("Disk full"));
    await Promise.resolve();
  });
  expect(source.state).toHaveBeenCalled();
  expect(source.save).toHaveBeenCalledTimes(2);
  expect(source.save).toHaveBeenLastCalledWith({
    sound: { ...initial.settings.sound, workingVolume: 0.8, alertVolume: 0.6, alerts: false },
  });
});

test("closing Settings submits queued sound edits before a reopened view saves", async () => {
  const initial = setupState({ setupComplete: true });
  const source = fake(initial);
  let finish: (state: SetupState) => void = () => {};
  source.save.mockImplementationOnce(
    () =>
      new Promise<SetupState>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <Preflight source={source} initial={initial} settingsMode onLaunched={vi.fn()} />,
  );
  fireEvent.click(button("Sound"));
  fireEvent.change(screen.getByLabelText("Working volume"), { target: { value: "20" } });
  fireEvent.change(screen.getByLabelText("Working volume"), { target: { value: "80" } });
  view.unmount();
  expect(source.save).toHaveBeenCalledTimes(2);
  render(
    <Preflight source={source} initial={await source.state()} settingsMode onLaunched={vi.fn()} />,
  );
  fireEvent.click(button("Sound"));
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Working volume"), { target: { value: "60" } });
    finish(setupState({ sound: { ...initial.settings.sound, workingVolume: 0.2 } }));
    await Promise.resolve();
  });
  expect(source.save).toHaveBeenCalledTimes(3);
  expect((await source.state()).settings.sound.workingVolume).toBe(0.6);
  expect(screen.getByLabelText("Working volume")).toHaveProperty("value", "60");
});

test("a rejected final sound save restores main's settings and permits another edit", async () => {
  const initial = setupState({ setupComplete: true });
  const source = fake(initial);
  source.save.mockRejectedValueOnce(Error("Disk full"));
  render(
    <ErrorPresentation>
      <Preflight source={source} initial={initial} settingsMode onLaunched={vi.fn()} />
      <BackgroundErrorMark />
    </ErrorPresentation>,
  );
  fireEvent.click(button("Sound"));
  const slider = screen.getByLabelText("Working volume");
  await act(async () => {
    fireEvent.change(slider, { target: { value: "80" } });
    await Promise.resolve();
  });
  expect(screen.getByText("Unable to save sound preferences.").textContent).toContain(
    "Unable to save sound preferences.",
  );
  expect(slider).toHaveProperty("value", "15");
  source.save.mockRejectedValueOnce(Error("Offline"));
  source.state.mockRejectedValueOnce(Error("Offline"));
  await act(async () => {
    fireEvent.change(slider, { target: { value: "70" } });
    await Promise.resolve();
  });
  expect(screen.getByText("Unable to save sound preferences.").textContent).toContain(
    "Unable to save sound preferences.",
  );
  await act(async () => {
    fireEvent.change(slider, { target: { value: "60" } });
    await Promise.resolve();
  });
  expect(slider).toHaveProperty("value", "60");
  expect((await source.state()).settings.sound.workingVolume).toBe(0.6);
});

test("first run walks every step, saves each choice, and launches", async () => {
  const source = fake(setupState());
  const launched = vi.fn();
  render(<Preflight source={source} initial={setupState()} onLaunched={launched} />);
  expect(document.activeElement?.tagName).toBe("H1");
  // Later steps open only as the user reaches them.
  expect(button(/Agents/)).toHaveProperty("disabled", true);

  fireEvent.click(button("Start preflight"));
  expect(document.activeElement?.textContent).toBe("Agents");
  await screen.findByText("3 agents ready");
  expect(document.querySelectorAll(".agent-card")).toHaveLength(3);
  expect(screen.getByText("/bin/claude")).toBeTruthy();
  expect(screen.getByText("2.1.300")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Codex" }));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({
      agents: { claude: true, codex: false, agy: true },
    });
  });
  await screen.findByText("2 agents ready");
  fireEvent.click(screen.getByRole("checkbox", { name: "Attach hooks" }));
  // With hooks off, every found agent falls back to the rules, immediately.
  await screen.findAllByText("Screen rules active · hooks off");
  fireEvent.click(button("Scan again"));
  expect(source.scanAgents).toHaveBeenLastCalledWith(true);
  await screen.findByText("Scan again");

  fireEvent.click(button("Continue"));
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /^\/home\/me\/code/ }));
  await screen.findByText("1 of 2 selected");
  expect(screen.getByRole("checkbox", { name: /^app/ })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: /^old/ })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox", { name: /^old/ }));
  expect(screen.getByText("2 repositories selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /^old/ }));
  expect(screen.getByText("1 repository selected")).toBeTruthy();

  // Leaving Repositories saves before readiness; Back returns directly to the selection.
  fireEvent.click(button("Continue"));
  await screen.findByText("All stations go.");
  expect(source.apply).toHaveBeenCalledWith(["/home/me/code/app"]);
  expect(screen.queryByRole("button", { name: /Worktrees/ })).toBeNull();
  fireEvent.click(button("Back"));
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  fireEvent.click(button("Continue"));
  expect(screen.getByText("All stations go.")).toBeTruthy();
  fireEvent.click(button("Launch"));
  const launch = await screen.findByRole("dialog", { name: "Launch" });
  expect(source.save).toHaveBeenLastCalledWith({ setupComplete: true });
  // Reduced motion shows a still frame; Escape skips it.
  expect(within(launch).getByText("Takeoff was faster than expected.")).toBeTruthy();
  fireEvent.keyDown(launch, { key: "Escape" });
  expect(launched).toHaveBeenCalledOnce();
  expect(launched.mock.calls[0]?.[0]).toMatchObject({
    settings: { setupComplete: true, hooks: false, worktreeLocation: "root" },
  });
});

test("an agent whose version can't be read still gets the same card", async () => {
  const quiet = { ...installation("claude"), version: null };
  const source = fake(setupState(), report(quiet, installation("codex"), installation("agy")));
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  expect(screen.getByText("Version unknown")).toBeTruthy();
  expect(screen.getByText("/bin/claude")).toBeTruthy();
});

test("with no agents installed, go / no-go holds and links back to each fix", async () => {
  const none = report(installation("claude", false), installation("codex", false));
  const source = fake(setupState(), none);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("No agents ready yet · needed to launch");
  expect(screen.getAllByText("Not found")).toHaveLength(3);
  expect(screen.getAllByRole("switch")).toHaveLength(3);
  expect(screen.getAllByText("Not found")).toHaveLength(3);
  for (let step = 0; step < 2; step++) fireEvent.click(button("Continue"));
  expect(screen.getByText("Hold. Something needs fixing.")).toBeTruthy();
  expect(button("Launch")).toHaveProperty("disabled", true);
  expect(screen.getAllByText("NO-GO")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[1] as HTMLElement);
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  fireEvent.click(button(/Go \/ no-go/));
  fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[0] as HTMLElement);
  expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
  fireEvent.click(button("Back"));
  expect(screen.getByText("Start preflight")).toBeTruthy();
});

test("a replay opens every step and closes with Escape or the rail button", async () => {
  const close = vi.fn();
  const initial = setupState({ setupComplete: true });
  render(
    <Preflight source={fake(initial)} initial={initial} onLaunched={vi.fn()} onClose={close} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(button(/Go \/ no-go/));
  expect(screen.getByText("Hold. Something needs fixing.")).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(button("Back to board · Esc"));
  expect(close).toHaveBeenCalledTimes(2);
});

test("errors from main are shown without the IPC wrapper", async () => {
  const source = fake(setupState());
  source.scanAgents.mockRejectedValueOnce(new Error("Login shell failed"));
  source.repositories.mockRejectedValueOnce(new Error("State unreadable"));
  source.save.mockRejectedValueOnce(
    new Error("Error invoking remote method 'setup:save': Error: Disk full"),
  );
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  await screen.findByText("Unable to load repositories.");
  fireEvent.click(screen.getByLabelText("Dark"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Unable to update settings.");
  });
  expect(message("plain")).toBe("Unable to update settings.");
});

test("a failed launch save keeps preflight open with the error", async () => {
  const source = fake(setupState());
  source.repositories.mockResolvedValue([{ path: "/code/app", name: "app" }]);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  for (let step = 0; step < 2; step++) fireEvent.click(button("Continue"));
  await screen.findByText("All stations go.");
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(button("Launch"));
  await screen.findByText("Unable to update settings.");
  expect(screen.getByRole("dialog", { name: "Action failed" })).toBeTruthy();
});

test("appearance applies at once, follows shortcuts from main, and stays within its steps", async () => {
  const source = fake(setupState({ interfaceScale: 250 }));
  render(
    <Preflight
      source={source}
      initial={setupState({ interfaceScale: 250 })}
      onLaunched={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(screen.getByRole("radio", { name: "Dark" })).toHaveProperty("checked", true);
  expect(source.save).toHaveBeenCalledWith({ colorMode: "dark" });
  fireEvent.click(button("Larger"));
  expect(source.save).toHaveBeenLastCalledWith({ interfaceScale: 300 });
  expect(screen.getByText("300%")).toBeTruthy();
  expect(button("Larger")).toHaveProperty("disabled", true);
  // Scrolling over the size steps it: down is smaller, up is larger.
  const size = screen.getByText("300%");
  fireEvent.wheel(size, { deltaY: 100 });
  expect(screen.getByText("250%")).toBeTruthy();
  // Small trackpad deltas add up to a step.
  fireEvent.wheel(screen.getByText("250%"), { deltaY: 30 });
  expect(screen.getByText("250%")).toBeTruthy();
  fireEvent.wheel(screen.getByText("250%"), { deltaY: 30 });
  expect(screen.getByText("200%")).toBeTruthy();
  // A mouse wheel in line mode: each notch is a step.
  fireEvent.wheel(screen.getByText("200%"), { deltaY: -3, deltaMode: 1 });
  expect(screen.getByText("250%")).toBeTruthy();
  fireEvent.wheel(screen.getByText("250%"), { deltaY: -100 });
  fireEvent.wheel(screen.getByText("300%"), { deltaY: -100 });
  expect(screen.getByText("300%")).toBeTruthy();
  expect(source.save).toHaveBeenLastCalledWith({ interfaceScale: 300 });
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  // A shortcut handled in main arrives as a settings change.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    changed?.(setupState({ interfaceScale: 80 }));
    await Promise.resolve();
  });
  expect(screen.getByText("80%")).toBeTruthy();
  expect(button("Smaller")).toHaveProperty("disabled", true);
  expect(screen.getByText("Ctrl+Shift+= / − / 0")).toBeTruthy();
  // If main refuses a change, its own settings come back.
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(button("Larger"));
  expect(screen.getByText("90%")).toBeTruthy();
  await screen.findByText("Unable to update settings.");
  // The fake last saved 300, so that is what comes back.
  await waitFor(() => {
    expect(screen.getByText("300%")).toBeTruthy();
  });
});

test("the size control steps down, and shows macOS shortcuts on a Mac", () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const source = fake(setupState({ interfaceScale: 175 }));
  render(
    <Preflight
      source={source}
      initial={setupState({ interfaceScale: 175 })}
      onLaunched={vi.fn()}
    />,
  );
  // Above 150 the steps follow Chromium's zoom levels.
  fireEvent.click(button("Smaller"));
  expect(source.save).toHaveBeenCalledWith({ interfaceScale: 150 });
  fireEvent.click(button("Smaller"));
  expect(source.save).toHaveBeenLastCalledWith({ interfaceScale: 140 });
  expect(screen.getByText("⌘ + / − / 0")).toBeTruthy();
  platform.mockRestore();
});

test("a refused or failed selection keeps you on Repositories with the reason", async () => {
  const source = fake(setupState());
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  fireEvent.click(button("Continue"));
  fireEvent.click(await screen.findByRole("button", { name: /^\/home\/me\/code/ }));
  await screen.findByText("1 of 2 selected");
  source.apply.mockResolvedValueOnce({
    repositories: [],
    failures: [{ path: "/home/me/code/app", message: "Has 1 worktree Foom made; remove it first" }],
  });
  fireEvent.click(button("Continue"));
  expect((await screen.findByRole("alert")).textContent).toBe("Unable to update repositories.");
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  source.apply.mockRejectedValueOnce(new Error("Choose repositories from the latest scan"));
  fireEvent.click(button("Continue"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Unable to update settings.");
  });
  // Nothing to save: moving on needs no apply.
  fireEvent.click(screen.getByRole("checkbox", { name: /^app/ }));
  fireEvent.click(button("Back"));
  expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
  expect(source.apply).toHaveBeenCalledTimes(2);
});

test("scans show live progress; a saved folder is rescanned on arrival; failures are reported", async () => {
  const saved = setupState({ codeFolder: "/home/me/code", setupComplete: true });
  const source = fake(saved);
  let report: (progress: ScanProgress) => void = () => {};
  let finish: (scan: CodeScan | null) => void = () => {};
  source.scan.mockImplementation((_id, _folder, onProgress) => {
    report = onProgress;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  render(<Preflight source={source} initial={saved} onLaunched={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(button(/Repositories/));
  expect(source.scan).toHaveBeenCalledWith(
    expect.any(String),
    "/home/me/code",
    expect.any(Function),
  );
  act(() => {
    report({ folders: 9, repositories: 2 });
  });
  expect(screen.getByText("Scanning /home/me/code… 9 folders, 2 repositories")).toBeTruthy();
  // Leaving and coming back mid-scan doesn't start another.
  fireEvent.click(button(/Agents/));
  fireEvent.click(button(/Repositories/));
  expect(source.scan).toHaveBeenCalledOnce();
  await act(async () => {
    finish(codeScan);
    await Promise.resolve();
  });
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();

  // A cancelled picker leaves the list as it was; a failed scan says why.
  fireEvent.click(button("Change folder"));
  await act(async () => {
    finish(null);
    await Promise.resolve();
  });
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
  source.scan.mockRejectedValueOnce(
    new Error("Error invoking remote method 'setup:scan-code': Error: EACCES"),
  );
  fireEvent.click(button("Scan again"));
  expect((await screen.findByRole("alert")).textContent).toBe("Unable to update settings.");
});

test("Settings shares setup controls, saves immediately and exposes planned sections", async () => {
  const initial = setupState({ setupComplete: true });
  const source = fake(initial);
  const close = vi.fn();
  render(
    <Preflight
      source={source}
      initial={initial}
      settingsMode
      onLaunched={vi.fn()}
      onClose={close}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "Claude Code" })).toHaveProperty("disabled", false);
  });
  const closeControl = button("Close settings (Esc)");
  expect(closeControl.title).toBe("Close settings (Esc)");
  expect(closeControl.tabIndex).toBe(0);
  expect(screen.getByRole("region", { name: "Settings" }).firstElementChild).toBe(closeControl);
  expect(screen.queryByText("Back to terminal · Esc")).toBeNull();
  expect(screen.queryByText("Continue")).toBeNull();
  fireEvent.click(screen.getByLabelText("Attach hooks"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ hooks: false });
  });
  fireEvent.click(button("Repositories"));
  fireEvent.click(await screen.findByRole("button", { name: /code.*2 repositories/ }));
  await screen.findByText("0 of 2 selected");
  fireEvent.click(screen.getByRole("checkbox", { name: /app/ }));
  await waitFor(() => {
    expect(source.apply).toHaveBeenCalledWith(["/home/me/code/app"]);
  });
  await waitFor(() => {
    expect(button("General")).toHaveProperty("disabled", false);
  });
  fireEvent.click(button("General"));
  fireEvent.click(screen.getByLabelText(/Put them next to/));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ worktreeLocation: "adjacent" });
  });
  expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  fireEvent.click(button("Appearance"));
  expect(screen.queryByRole("group", { name: "Interface themes" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Dark"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ colorMode: "dark" });
  });
  fireEvent.click(button("Larger"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ interfaceScale: 110 });
  });
  fireEvent.click(button("Terminal"));
  expect(screen.queryByRole("group", { name: "Terminal colors" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Terminal font size"), { target: { value: "18" } });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ terminalFontSize: 18 });
  });
  fireEvent.click(button("Themes"));
  expect(screen.getByText(/Hack Nerd Font Mono ·/).style.fontSize).toBe("18px");
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Interface themes" }).parentElement ?? document.body,
    ).getByRole("button", { name: "Open themes folder" }),
  );
  expect(source.openThemesFolder).toHaveBeenCalledWith("theme");
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Terminal colors" }).parentElement ?? document.body,
    ).getByRole("button", { name: "Open themes folder" }),
  );
  expect(source.openThemesFolder).toHaveBeenCalledWith("terminal-theme");
  expect(screen.getByRole("group", { name: "Interface themes" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Terminal colors" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Worktrees" })).toBeNull();
  fireEvent.click(button("General"));
  const restore = screen.getByRole("checkbox", { name: "Restore sessions on launch" });
  expect(restore).toHaveProperty("checked", true);
  const limit = screen.getByRole("spinbutton", { name: "Concurrent children per orchestrator" });
  expect(limit).toHaveProperty("value", "4");
  for (const value of ["", "0", "17", "1.5"]) fireEvent.change(limit, { target: { value } });
  expect(source.save).not.toHaveBeenCalledWith({ concurrentChildren: 0 });
  fireEvent.change(limit, { target: { value: "2" } });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ concurrentChildren: 2 });
  });
  const reminder = screen.getByRole("spinbutton", {
    name: "Unread child reminder (minutes; 0 turns off)",
  });
  expect(reminder).toHaveProperty("value", "5");
  for (const value of ["", "-1", "1441", "1.5"]) fireEvent.change(reminder, { target: { value } });
  expect(source.save).not.toHaveBeenCalledWith({ unreadChildMinutes: -1 });
  fireEvent.change(reminder, { target: { value: "0" } });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ unreadChildMinutes: 0 });
  });
  fireEvent.click(restore);
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ restoreSessions: false });
  });
  fireEvent.click(button("Sound"));
  expect(screen.getByRole("checkbox", { name: "Alerts on" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "a" });
  expect(close).not.toHaveBeenCalled();
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  dialog.remove();
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("Settings rolls back refused repository changes and prevents leaving during a write", async () => {
  const initial = setupState({ setupComplete: true, codeFolder: "/home/me/code" });
  const source = fake(initial);
  source.repositories.mockResolvedValue([{ path: "/elsewhere/keep", name: "keep" }]);
  const close = vi.fn();
  render(
    <Preflight
      source={source}
      initial={initial}
      settingsMode
      onLaunched={vi.fn()}
      onClose={close}
    />,
  );
  fireEvent.click(button("Repositories"));
  await screen.findByText("0 of 2 selected");
  let finish: (value: RepositoryUpdate) => void = () => {};
  source.apply.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /app/ }));
  expect(button("Terminal")).toHaveProperty("disabled", true);
  expect(button("Close settings (Esc)")).toHaveProperty("disabled", true);
  fireEvent.click(button("Close settings (Esc)"));
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    await Promise.resolve();
    finish({
      repositories: [{ path: "/elsewhere/keep", name: "keep" }],
      failures: [{ path: "/home/me/code/app", message: "Repository unavailable" }],
    });
  });
  expect(screen.getByRole("alert").textContent).toBe("Unable to update repositories.");
  expect(screen.getByRole("checkbox", { name: /app/ })).toHaveProperty("checked", false);
  source.apply.mockRejectedValueOnce(new Error("Cannot write"));
  fireEvent.click(screen.getByRole("checkbox", { name: /app/ }));
  await screen.findByText("Unable to update settings.");
  expect(source.apply).toHaveBeenLastCalledWith(["/home/me/code/app"]);
  expect(screen.getByRole("checkbox", { name: /app/ })).toHaveProperty("checked", false);
  fireEvent.click(button("Close settings (Esc)"));
  expect(close).toHaveBeenCalledOnce();
});

test("repository controls explain immediate selection when used outside guided setup", async () => {
  render(
    <RepositoriesStep
      recentDays={30}
      onRecentDays={vi.fn()}
      headingRef={{ current: null }}
      source={fake(setupState())}
      code={undefined}
      repositories={[]}
      codeScanning={undefined}
      scanCode={vi.fn()}
      setCode={vi.fn()}
      immediate
    />,
  );
  expect(screen.getByText(/Changes to the selection apply immediately/)).toBeTruthy();
  await screen.findByRole("button", { name: "Choose folder…" });
});

test("Settings saves agent defaults through its source and retains the saved state", async () => {
  const state = setupState({ setupComplete: true });
  const source = fake(state);
  render(<Preflight source={source} initial={state} onLaunched={vi.fn()} settingsMode />);
  fireEvent.change(await screen.findByLabelText("Codex default arguments"), {
    target: { value: "--model\nexample" },
  });
  fireEvent.blur(screen.getByLabelText("Codex default arguments"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({
      agentArguments: { claude: [], codex: ["--model", "example"], agy: [] },
    });
  });
  expect(screen.getByLabelText("Codex default arguments")).toHaveProperty(
    "value",
    "--model\nexample",
  );
});

test.each([
  ["not-reviewed", "Trust review pending"],
  ["trusted", "Trusted · observed working"],
  ["declined", "Declined · Notify fallback"],
  ["outdated", "Outdated · review needed"],
] as const)("Codex setup explains %s without granting trust", async (hookState, label) => {
  const source = fake(
    setupState(),
    report({
      ...installation("codex"),
      healthSupported: true,
      healthInstructions: "/hooks in Codex",
      hookState,
      notifierReplacement: hookState !== "trusted",
    }),
  );
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText(label);
  expect(screen.getByText("/hooks in Codex")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /trust|approve/i })).toBeNull();
  expect(screen.queryByText("Notify + screen rules active") !== null).toBe(hookState !== "trusted");
});

test("agent setup waits for explicit plugin installation, refreshes status and reports failed changes", async () => {
  const source = fake(setupState());
  const notInstalled = report({ ...installation("agy"), agyPlugin: { state: "not-installed" } });
  const installed = report({
    ...installation("agy"),
    agyPlugin: { state: "installed", version: 1 },
  });
  source.scanAgents.mockResolvedValue(notInstalled);
  source.changeAgyPlugin.mockResolvedValue(installed);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByRole("button", { name: "Install plugin" });
  expect(source.changeAgyPlugin).not.toHaveBeenCalled();
  fireEvent.click(button("Install plugin"));
  await screen.findByRole("button", { name: "Remove plugin" });
  expect(source.changeAgyPlugin).toHaveBeenCalledWith("install");
  source.changeAgyPlugin.mockRejectedValueOnce(new Error("Plugin command failed"));
  fireEvent.click(button("Remove plugin"));
  await screen.findByText("Unable to update settings.");
  expect(button("Remove plugin")).toHaveProperty("disabled", false);
});

test("agent settings report capability-gated MCP availability and policy limits", async () => {
  const available = {
    ...installation("claude"),
    mcp: true,
    mcpReason: "Managed policy may deny attachment.",
  };
  const unavailable = {
    ...installation("codex"),
    mcp: false,
    mcpReason: "Version below the supported floor.",
  };
  render(
    <Preflight
      source={fake(setupState(), report(available, unavailable))}
      initial={setupState()}
      onLaunched={vi.fn()}
    />,
  );
  fireEvent.click(button("Start preflight"));
  const claude = await screen.findByRole("region", { name: "Claude Code" });
  const codex = screen.getByRole("region", { name: "Codex" });
  expect(within(claude).getAllByText("Available").length).toBeGreaterThan(0);
  expect(within(codex).getAllByText("Unavailable").length).toBeGreaterThan(0);
});

test.each([
  [false, true, "not-installed", true],
  [true, true, "not-installed", false],
  [false, false, "not-installed", false],
  [false, true, "installed", false],
] as const)(
  "Settings plugin marker follows answer %s, PATH %s and state %s",
  async (answered, detected, pluginState, marker) => {
    const initial = setupState({ setupComplete: true, agyPluginOfferAnswered: answered });
    const source = fake(
      initial,
      report({ ...installation("agy", detected), agyPlugin: { state: pluginState } }),
    );
    render(<Preflight source={source} initial={initial} onLaunched={vi.fn()} settingsMode />);
    await waitFor(() => {
      expect(source.scanAgents).toHaveBeenCalled();
    });
    await act(async () => {});
    expect(Boolean(screen.queryByText("Plugin available"))).toBe(marker);
    expect(Boolean(screen.queryByText(/Lifecycle plugin/))).toBe(detected);
  },
);

test("Settings General auto-removal toggle applies to all repositories", async () => {
  const source = fake(setupState());
  source.repositories.mockResolvedValue([
    { name: "app", path: "/home/me/code/app" },
    { name: "other", path: "/home/me/code/other" },
  ]);
  render(<Preflight source={source} initial={setupState()} settingsMode onLaunched={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Repositories" }));
  expect(screen.queryByRole("checkbox", { name: /Auto-remove merged worktrees/ })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "General" }));
  const toggle = await screen.findByRole("checkbox", { name: "Auto-remove merged worktrees" });
  expect(toggle).toHaveProperty("checked", false);
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ autoRemoveMergedWorktrees: true });
    expect(toggle).toHaveProperty("checked", true);
  });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ autoRemoveMergedWorktrees: false });
    expect(toggle).toHaveProperty("checked", false);
  });
});

test("concurrent card saves preserve other agents' defaults and continue after a refusal", async () => {
  const state = setupState({ setupComplete: true });
  const source = fake(state);
  render(<Preflight source={source} initial={state} settingsMode onLaunched={vi.fn()} />);
  const claude = await screen.findByLabelText("Claude Code default arguments");
  const codex = screen.getByLabelText("Codex default arguments");
  source.save.mockRejectedValueOnce(Error("First save refused"));
  fireEvent.change(claude, { target: { value: "--model\none" } });
  fireEvent.blur(claude);
  fireEvent.change(codex, { target: { value: "--model\ntwo" } });
  fireEvent.blur(codex);
  await screen.findByText("Unable to update settings.");
  await waitFor(() => {
    expect(source.save).toHaveBeenLastCalledWith({
      agentArguments: { claude: [], codex: ["--model", "two"], agy: [] },
    });
  });
  fireEvent.change(claude, { target: { value: "--model\nthree" } });
  fireEvent.blur(claude);
  await waitFor(() => {
    expect(source.save).toHaveBeenLastCalledWith({
      agentArguments: { claude: ["--model", "three"], codex: ["--model", "two"], agy: [] },
    });
  });
});

test("General discloses GitHub polling and saves its privacy toggle", async () => {
  const initial = setupState();
  const source = fake(initial);
  render(<Preflight source={source} initial={initial} settingsMode onLaunched={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "General" }));
  expect(
    screen.getByText(
      "Foom uses your GitHub CLI to send repository and branch names to GitHub. It sends no terminal content.",
    ),
  ).toBeTruthy();
  const toggle = screen.getByRole("checkbox", { name: "Show pull requests and checks" });
  expect(toggle).toHaveProperty("checked", false);
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ showPullRequests: true });
  });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ showPullRequests: false });
  });
});

test.each(["root", "adjacent"] as const)(
  "incomplete setup preserves saved %s location through launch and Settings",
  async (worktreeLocation) => {
    const initial = setupState({ worktreeLocation });
    const source = fake(initial);
    source.repositories.mockResolvedValue([{ path: "/code/app", name: "app" }]);
    const view = render(<Preflight source={source} initial={initial} onLaunched={vi.fn()} />);
    fireEvent.click(button("Start preflight"));
    await screen.findByText("3 agents ready");
    fireEvent.click(button("Continue"));
    fireEvent.click(button("Continue"));
    await screen.findByText("All stations go.");
    fireEvent.click(button("Launch"));
    await screen.findByRole("dialog", { name: "Launch" });
    expect((await source.state()).settings.worktreeLocation).toBe(worktreeLocation);
    expect(source.save).toHaveBeenCalledExactlyOnceWith({ setupComplete: true });
    view.unmount();
    render(
      <Preflight
        source={source}
        initial={await source.state()}
        onLaunched={vi.fn()}
        settingsMode
      />,
    );
    fireEvent.click(button("General"));
    expect(
      screen.getByRole("radio", {
        name: worktreeLocation === "root" ? /Keep worktrees/ : /Put them next to/,
      }),
    ).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: /Put them next to/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Keep worktrees/ }));
    await waitFor(() => {
      expect(source.save).toHaveBeenLastCalledWith({ worktreeLocation: "root" });
    });
    expect(screen.getByText("/home/me/.foom/worktrees/app/feat/search")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Put them next to/ }));
    await waitFor(() => {
      expect(source.save).toHaveBeenLastCalledWith({ worktreeLocation: "adjacent" });
    });
    expect(screen.getByText("/code/app-feat/search")).toBeTruthy();
  },
);

test("editing recent days in first run saves without rescanning or clearing selected repositories", async () => {
  const initial = setupState();
  const source = fake(initial);
  render(<Preflight source={source} initial={initial} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  fireEvent.click(button("Continue"));
  fireEvent.click(await screen.findByRole("button", { name: /code.*2 repositories/ }));
  await screen.findByText("1 of 2 selected");
  const recent = screen.getByRole("region", { name: "Recent · last 30 days" });
  fireEvent.change(within(recent).getByRole("spinbutton"), { target: { value: "100" } });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ recentRepositoryDays: 100 });
  });
  expect(
    within(screen.getByRole("region", { name: "Recent · last 100 days" })).getAllByRole("checkbox"),
  ).toHaveLength(2);
  expect(screen.getByRole("checkbox", { name: "app" })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: "old" })).toHaveProperty("checked", false);
  expect(source.scan).toHaveBeenCalledTimes(1);
});
