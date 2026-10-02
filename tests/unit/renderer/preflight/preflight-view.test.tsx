// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { message } from "../../../../src/renderer/preflight/preflight-evaluator";
import { Preflight } from "../../../../src/renderer/preflight/preflight-view";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type {
  ApiProvider,
  ModelList,
  ProbeFailure,
  ProbeResult,
  ProbeUpdate,
} from "../../../../src/shared/inference";
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

const all = report(installation("claude"), installation("codex"), installation("agy"));
const passed: ProbeResult = {
  ok: true,
  message: "needs_input · confidence 0.94 in 1.2s",
  verdict: { state: "needs_input", reason: "r", signal: "model", confidence: 0.94 },
  timings: { connectMs: 1, firstTokenMs: 300, totalMs: 1234 },
  request: {
    url: "http://127.0.0.1:11434/v1/chat/completions",
    model: "qwen3:8b",
    parameters: { model: "qwen3:8b", stream: true },
    prompt: "Classify … Would you like me to apply these changes?",
  },
  reply: '{"state":"needs_input","confidence":0.94}',
  thinking: 3,
};
const failed = (failure: ProbeFailure, message: string): ProbeResult => ({
  ...passed,
  ok: false,
  failure,
  message,
});

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
    state: vi.fn(() => Promise.resolve(state)),
    save: vi.fn((patch: SettingsPatch) =>
      update({ ...state, settings: { ...state.settings, ...patch } }),
    ),
    setKey: vi.fn((provider: ApiProvider, _key: string) =>
      update({ ...state, keys: { ...state.keys, [provider]: true } }),
    ),
    removeKey: vi.fn((provider: ApiProvider) =>
      update({ ...state, keys: { ...state.keys, [provider]: false } }),
    ),
    check: vi.fn(
      (_id: string, _config: unknown, _limit: number, onUpdate: (update: ProbeUpdate) => void) => {
        onUpdate({
          kind: "step",
          event: { step: "connect", status: "ok", label: "Connected to 127.0.0.1:11434", atMs: 1 },
        });
        return Promise.resolve(passed);
      },
    ),
    cancel: vi.fn((_id: string) => Promise.resolve()),
    models: vi.fn((_endpoint: string) =>
      Promise.resolve<ModelList>({ ok: true, models: ["qwen3:8b"], server: "Ollama 0.32.14" }),
    ),
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
});
afterEach(() => {
  cleanup();
});

test("first run walks every step, saves each choice, and launches", async () => {
  const source = fake(setupState());
  const launched = vi.fn();
  render(<Preflight source={source} initial={setupState()} onLaunched={launched} />);
  expect(document.activeElement?.tagName).toBe("H1");
  // Later steps open only as the user reaches them.
  expect(button(/Agents/)).toHaveProperty("disabled", true);

  fireEvent.click(button("Start preflight"));
  expect(document.activeElement?.textContent).toBe("Which agents do you run?");
  await screen.findByText("3 agents ready");
  expect(screen.getAllByText("Found")).toHaveLength(3);
  // Every card reads the same: name and command chip, then version badge and signal chip.
  expect(Array.from(document.querySelectorAll(".badge"), (badge) => badge.textContent)).toEqual([
    "Version2.1.300",
    "Version0.155.1",
    "Version1.2.13",
  ]);
  const tip = (name: string) => {
    const trigger = screen.getByRole("button", { name });
    return document.getElementById(trigger.getAttribute("aria-describedby") ?? "")?.textContent;
  };
  // Explanations live in the chips' tooltips, not on the cards.
  expect(tip("claude")).toContain("Found at /bin/claude");
  expect(tip("claude")).toContain("Reports 2.1.300 (Claude Code)");
  expect(tip("Hooks")).toContain("hooks tell Foom");
  expect(tip("Notify")).toContain("Replaces your own Codex notifier");
  expect(screen.queryByText(/Replaces your own Codex notifier/, { selector: "p" })).toBeNull();
  fireEvent.click(screen.getByLabelText(/Codex/));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({
      agents: { claude: true, codex: false, agy: true },
    });
  });
  await screen.findByText("2 agents ready");
  fireEvent.click(screen.getByRole("checkbox", { name: /Attach Foom's hooks/ }));
  // With hooks off, every found agent falls back to the evaluator, immediately.
  expect(screen.getAllByRole("button", { name: "Evaluator" })).toHaveLength(3);
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

  // Leaving the step saves the selection; Worktrees is its own step.
  fireEvent.click(button("Continue"));
  await screen.findByText("Where should new worktrees go?");
  expect(source.apply).toHaveBeenCalledWith(["/home/me/code/app"]);
  expect(screen.getByText("/home/me/.foom/worktrees/app/feat/search")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Put them next to each repository/ }));
  await waitFor(() => {
    expect(source.save).toHaveBeenLastCalledWith({ worktreeLocation: "adjacent" });
  });
  expect(screen.getByText("/home/me/code/app-feat/search")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Keep worktrees in Foom's folder/ }));
  await waitFor(() => {
    expect(source.save).toHaveBeenLastCalledWith({ worktreeLocation: "root" });
  });
  expect(screen.getByText("/home/me/.foom/worktrees/app/feat/search")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /next to each repository/ }));
  await screen.findByText("/home/me/code/app-feat/search");
  fireEvent.click(button("Continue"));
  await screen.findByText("How should Foom read a terminal that goes quiet?");
  expect(screen.getByRole("radio", { name: /Use an agent you already have/ })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Use a local model/ }));
  expect(button("Run check")).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
    target: { value: "qwen3:8b" },
  });
  await screen.findByText("Ollama 0.32.14 · 1 model");
  fireEvent.click(button("Run check"));
  const local = { kind: "local", model: "qwen3:8b", endpoint: "http://127.0.0.1:11434/v1" };
  await screen.findByText(/needs_input · confidence 0.94 in 1.2s/);
  const steps = screen.getByRole("list", { name: "Check steps" });
  expect(within(steps).getByText("Connected to 127.0.0.1:11434")).toBeTruthy();
  expect(source.check).toHaveBeenCalledWith(expect.any(String), local, 5000, expect.any(Function));
  expect(source.save).toHaveBeenLastCalledWith({ inference: local });
  await screen.findByText(/qwen3:8b at http/);

  fireEvent.click(button("Continue"));
  expect(screen.getByText("All stations go.")).toBeTruthy();
  fireEvent.click(button("Back"));
  expect(screen.getByText("How should Foom read a terminal that goes quiet?")).toBeTruthy();
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
    settings: { setupComplete: true, hooks: false, worktreeLocation: "adjacent" },
  });
});

test("an agent whose version can't be read still gets the same card", async () => {
  const quiet = { ...installation("claude"), version: null };
  const source = fake(setupState(), report(quiet, installation("codex"), installation("agy")));
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  const badge = document.querySelector(".badge");
  expect(badge?.textContent).toBe("Versionunknown");
  expect(badge?.getAttribute("data-known")).toBe("false");
  const claude = screen.getByRole("button", { name: "claude" });
  const tip = document.getElementById(claude.getAttribute("aria-describedby") ?? "");
  expect(tip?.textContent).not.toContain("Reports");
});

test("with no agents installed, go / no-go holds and links back to each fix", async () => {
  const none = report(installation("claude", false), installation("codex", false));
  const source = fake(setupState(), none);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("No agents ready yet · needed to launch");
  expect(screen.getAllByText("Not found")).toHaveLength(3);
  expect(
    screen.getAllByRole("checkbox", { name: /Claude Code|Codex|Antigravity/ })[0],
  ).toHaveProperty("disabled", true);
  expect(screen.getAllByText("Not on your PATH.")).toHaveLength(3);
  for (let step = 0; step < 4; step++) fireEvent.click(button("Continue"));
  expect(screen.getByText("Hold. Something needs fixing.")).toBeTruthy();
  expect(button("Launch")).toHaveProperty("disabled", true);
  expect(screen.getAllByText("NO-GO")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[1] as HTMLElement);
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  fireEvent.click(button(/Go \/ no-go/));
  fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[0] as HTMLElement);
  expect(screen.getByText("Which agents do you run?")).toBeTruthy();
  fireEvent.click(button("Back"));
  expect(screen.getByText("Start preflight")).toBeTruthy();
});

test("API keys are saved, replaced and removed, and only a passing check is used", async () => {
  const source = fake(setupState());
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  fireEvent.click(screen.getByRole("radio", { name: /Use an API key/ }));
  expect(screen.getByText("Save a key, then run the check.")).toBeTruthy();
  expect(button("Run check")).toHaveProperty("disabled", true);
  expect(button("Save key")).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
  fireEvent.click(button("Save key"));
  await screen.findByText(/A key is saved/);
  expect(source.setKey).toHaveBeenCalledWith("anthropic", "sk-test");

  source.check.mockResolvedValueOnce(failed("auth", "The key was rejected (HTTP 401)"));
  fireEvent.click(button("Run check"));
  await screen.findByText("The key was rejected (HTTP 401)");
  expect(source.save).not.toHaveBeenCalled();
  source.check.mockRejectedValueOnce(
    new Error("Error invoking remote method 'setup:check': Error: Invalid inference model"),
  );
  fireEvent.click(button("Run check"));
  await screen.findByText("Invalid inference model");
  // The time limit is saved right away and used by the next check.
  fireEvent.change(screen.getByRole("combobox", { name: "Time limit" }), {
    target: { value: "10000" },
  });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ inferenceTimeoutMs: 10_000 });
  });
  fireEvent.click(button("Run check"));
  await screen.findByText(/Foom will use this source/);
  expect(source.save).toHaveBeenCalledWith({
    inference: { kind: "anthropic", model: "claude-haiku-4-5" },
  });
  await screen.findByText("Anthropic API · claude-haiku-4-5");

  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  expect(screen.queryByLabelText("API key")).toBeNull();
  // A provider without a saved key asks for one.
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
    target: { value: "openai" },
  });
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Model" })).toHaveProperty("value", "gpt-4.1-mini");
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
    target: { value: "anthropic" },
  });
  fireEvent.click(button("Remove key"));
  await waitFor(() => {
    expect(source.removeKey).toHaveBeenCalledWith("anthropic");
  });
  await screen.findByLabelText("API key");
  fireEvent.click(screen.getByRole("radio", { name: /Rules only/ }));
  await waitFor(() => {
    expect(source.save).toHaveBeenLastCalledWith({ inference: { kind: "rules" } });
  });
  expect(screen.queryByText("Try it on a sample")).toBeNull();
});

test("a saved model source reopens configured, and missing encryption disables API keys", () => {
  const local = { kind: "local", model: "llama", endpoint: "http://127.0.0.1:8080/v1" } as const;
  const initial = setupState({ inference: local }, { secureStorage: false });
  render(<Preflight source={fake(initial)} initial={initial} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  expect(screen.getByRole("radio", { name: /Use an API key/ })).toHaveProperty("disabled", true);
  expect(screen.getByText(/can't encrypt keys/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Endpoint" })).toHaveProperty(
    "value",
    "http://127.0.0.1:8080/v1",
  );
  expect(screen.getByText("In use. Run the check again any time.")).toBeTruthy();
  cleanup();
  const cloud = setupState(
    { inference: { kind: "google", model: "gemini-2.5-flash" } },
    { keys: { anthropic: false, openai: false, google: true } },
  );
  render(<Preflight source={fake(cloud)} initial={cloud} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  expect(screen.getByRole("combobox", { name: "Provider" })).toHaveProperty("value", "google");
  expect(screen.getByText(/A key is saved/)).toBeTruthy();
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
  await screen.findByRole("alert");
  fireEvent.click(button("Start preflight"));
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
  fireEvent.click(screen.getByRole("radio", { name: /next to each repository/ }));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Disk full");
  });
  fireEvent.click(button("Continue"));
  fireEvent.click(screen.getByRole("radio", { name: /Use a local model/ }));
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(screen.getByRole("radio", { name: /Rules only/ }));
  await screen.findByText("Disk full");
  expect(message("plain")).toBe("plain");
});

test("a failed launch save keeps preflight open with the error", async () => {
  const source = fake(setupState());
  source.repositories.mockResolvedValue([{ path: "/code/app", name: "app" }]);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  for (let step = 0; step < 4; step++) fireEvent.click(button("Continue"));
  await screen.findByText("All stations go.");
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(button("Launch"));
  await screen.findByText("Disk full");
  expect(screen.queryByRole("dialog")).toBeNull();
});

async function toLocal(source: ReturnType<typeof fake>) {
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  fireEvent.click(screen.getByRole("radio", { name: /Use a local model/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
    target: { value: "qwen3:8b" },
  });
  await screen.findByText(/Ollama 0.32.14/);
}

test("a running check shows live steps and can be cancelled; editing also cancels it", async () => {
  const source = fake(setupState());
  let finish: (result: ProbeResult) => void = () => {};
  let report: (update: ProbeUpdate) => void = () => {};
  source.check.mockImplementation((_id, _config, _limit, onUpdate) => {
    report = onUpdate;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await toLocal(source);
  fireEvent.click(button("Run check"));
  expect(button("Run check")).toHaveProperty("disabled", true);
  expect(screen.getByRole("progressbar", { name: "Time limit" })).toBeTruthy();
  act(() => {
    report({
      kind: "step",
      event: { step: "load", status: "running", label: "Loading qwen3:8b into memory", atMs: 3 },
    });
    report({ kind: "stream", thinking: 12, reply: '{"state"' });
  });
  const steps = screen.getByRole("list", { name: "Check steps" });
  expect(within(steps).getByText("Loading qwen3:8b into memory")).toBeTruthy();
  expect(screen.getByText("Thinking: 12 chunks")).toBeTruthy();
  fireEvent.click(button("Cancel"));
  const id = source.check.mock.calls[0]?.[0];
  expect(source.cancel).toHaveBeenCalledWith(id);
  await act(async () => {
    finish(failed("cancelled", "Cancelled"));
    await Promise.resolve();
  });
  expect(screen.getByText("Cancelled")).toBeTruthy();
  expect(source.save.mock.calls.some(([patch]) => "inference" in patch)).toBe(false);

  // A check still running when the model name changes is cancelled and forgotten.
  fireEvent.click(button("Run check"));
  const second = source.check.mock.calls[1]?.[0];
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
    target: { value: "llama3.2" },
  });
  expect(source.cancel).toHaveBeenLastCalledWith(second);
  expect(screen.queryByRole("progressbar")).toBeNull();
  await act(async () => {
    finish(passed);
    await Promise.resolve();
  });
  // Its late result is ignored, so nothing is saved.
  expect(screen.queryByText(/Foom will use this source/)).toBeNull();
  expect(await screen.findByText(/llama3.2 isn't one of them/)).toBeTruthy();
});

test("leaving the evaluator cancels its check and a late success cannot replace rules only", async () => {
  const source = fake(setupState());
  let finish: (result: ProbeResult) => void = () => {};
  source.check.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await toLocal(source);
  fireEvent.click(button("Run check"));
  const id = source.check.mock.calls[0]?.[0];
  fireEvent.click(button("Continue"));
  fireEvent.click(button(/T-1.*Evaluator/));
  fireEvent.click(screen.getByRole("radio", { name: /Rules only/ }));
  await act(async () => {
    finish(passed);
    await Promise.resolve();
  });
  expect((await source.state()).settings.inference).toEqual({ kind: "rules" });
  expect(source.cancel).toHaveBeenCalledWith(id);
  expect(source.save.mock.calls.some(([patch]) => patch.inference?.kind === "local")).toBe(false);
});

test("the endpoint's model list reports failures in Foom's words", async () => {
  const source = fake(setupState());
  source.models.mockResolvedValue({
    ok: false,
    failure: "refused",
    message: "Connection refused: nothing is listening on 127.0.0.1:11434",
  });
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  fireEvent.click(screen.getByRole("radio", { name: /Use a local model/ }));
  await screen.findByText("Connection refused: nothing is listening on 127.0.0.1:11434");
  source.models.mockRejectedValueOnce(new Error("Local endpoint must use a loopback IP"));
  fireEvent.change(screen.getByRole("textbox", { name: "Endpoint" }), {
    target: { value: "http://example.com/v1" },
  });
  await screen.findByText("Local endpoint must use a loopback IP");
  source.models.mockResolvedValueOnce({ ok: true, models: ["a", "b"], server: null });
  fireEvent.change(screen.getByRole("textbox", { name: "Endpoint" }), {
    target: { value: "http://127.0.0.1:8080/v1" },
  });
  await screen.findByText("OpenAI-compatible server · 2 models");
  source.check.mockRejectedValueOnce(new Error("boom"));
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "a" } });
  fireEvent.click(button("Run check"));
  await screen.findByText("boom");
});

test("appearance applies at once, follows shortcuts from main, and stays within its steps", async () => {
  const source = fake(setupState({ interfaceScale: 140 }));
  render(
    <Preflight
      source={source}
      initial={setupState({ interfaceScale: 140 })}
      onLaunched={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(screen.getByRole("radio", { name: "Dark" })).toHaveProperty("checked", true);
  expect(source.save).toHaveBeenCalledWith({ colorMode: "dark" });
  fireEvent.click(button("Larger"));
  expect(source.save).toHaveBeenLastCalledWith({ interfaceScale: 150 });
  expect(screen.getByText("150%")).toBeTruthy();
  expect(button("Larger")).toHaveProperty("disabled", true);
  // Scrolling over the size steps it: down is smaller, up is larger.
  const size = screen.getByText("150%");
  fireEvent.wheel(size, { deltaY: 100 });
  expect(screen.getByText("140%")).toBeTruthy();
  // Small trackpad deltas add up to a step.
  fireEvent.wheel(screen.getByText("140%"), { deltaY: 30 });
  expect(screen.getByText("140%")).toBeTruthy();
  fireEvent.wheel(screen.getByText("140%"), { deltaY: 30 });
  expect(screen.getByText("130%")).toBeTruthy();
  // A mouse wheel in line mode: each notch is a step.
  fireEvent.wheel(screen.getByText("130%"), { deltaY: -3, deltaMode: 1 });
  expect(screen.getByText("140%")).toBeTruthy();
  fireEvent.wheel(screen.getByText("140%"), { deltaY: -100 });
  fireEvent.wheel(screen.getByText("150%"), { deltaY: -100 });
  expect(screen.getByText("150%")).toBeTruthy();
  expect(source.save).toHaveBeenLastCalledWith({ interfaceScale: 150 });
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
  expect(screen.getByText("Ctrl+Shift+= / − · Ctrl+0")).toBeTruthy();
  // If main refuses a change, its own settings come back.
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(button("Larger"));
  expect(screen.getByText("90%")).toBeTruthy();
  await screen.findByText("Disk full");
  // The fake last saved 150, so that is what comes back.
  await waitFor(() => {
    expect(screen.getByText("150%")).toBeTruthy();
  });
});

test("the size control steps down, and shows macOS shortcuts on a Mac", () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const source = fake(setupState({ interfaceScale: 120 }));
  render(
    <Preflight
      source={source}
      initial={setupState({ interfaceScale: 120 })}
      onLaunched={vi.fn()}
    />,
  );
  fireEvent.click(button("Smaller"));
  expect(source.save).toHaveBeenCalledWith({ interfaceScale: 110 });
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
  expect((await screen.findByRole("alert")).textContent).toBe(
    "app: Has 1 worktree Foom made; remove it first",
  );
  expect(screen.getByText("Where do you keep your code?")).toBeTruthy();
  source.apply.mockRejectedValueOnce(new Error("Choose repositories from the latest scan"));
  fireEvent.click(button("Continue"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Choose repositories from the latest scan");
  });
  // Nothing to save: moving on needs no apply.
  fireEvent.click(screen.getByRole("checkbox", { name: /^app/ }));
  fireEvent.click(button("Back"));
  expect(screen.getByText("Which agents do you run?")).toBeTruthy();
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
  expect((await screen.findByRole("alert")).textContent).toBe("EACCES");
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
    expect(screen.getByLabelText("Claude Code")).toHaveProperty("disabled", false);
  });
  expect(screen.queryByText("Continue")).toBeNull();
  fireEvent.click(screen.getByLabelText(/Attach Foom's hooks/));
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
    expect(button("Worktrees")).toHaveProperty("disabled", false);
  });
  fireEvent.click(button("Worktrees"));
  fireEvent.click(screen.getByLabelText(/Put them next to/));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ worktreeLocation: "adjacent" });
  });
  fireEvent.click(button("Evaluator"));
  expect(screen.getByText("How should Foom read a terminal that goes quiet?")).toBeTruthy();
  fireEvent.click(button("Appearance"));
  fireEvent.click(screen.getByLabelText("Dark"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ colorMode: "dark" });
  });
  fireEvent.click(button("Larger"));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ interfaceScale: 110 });
  });
  fireEvent.click(button("Terminal"));
  fireEvent.change(screen.getByLabelText("Terminal font size"), { target: { value: "18" } });
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({ terminalFontSize: 18 });
  });
  expect(screen.getByText(/Hack Nerd Font Mono ·/).style.fontSize).toBe("18px");
  fireEvent.click(button("Themes"));
  expect(screen.getByText(/Eclipse is the current theme/)).toBeTruthy();
  fireEvent.click(button("Sound"));
  expect(screen.getByText(/Sound controls are coming/)).toBeTruthy();
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
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    await Promise.resolve();
    finish({
      repositories: [{ path: "/elsewhere/keep", name: "keep" }],
      failures: [{ path: "/home/me/code/app", message: "Repository unavailable" }],
    });
  });
  expect(screen.getByRole("alert").textContent).toContain("Repository unavailable");
  expect(screen.getByRole("checkbox", { name: /app/ })).toHaveProperty("checked", false);
  source.apply.mockRejectedValueOnce(new Error("Cannot write"));
  fireEvent.click(screen.getByRole("checkbox", { name: /app/ }));
  await screen.findByText("Cannot write");
  expect(source.apply).toHaveBeenLastCalledWith(["/home/me/code/app"]);
  expect(screen.getByRole("checkbox", { name: /app/ })).toHaveProperty("checked", false);
  fireEvent.click(button("Back to terminal · Esc"));
  expect(close).toHaveBeenCalledOnce();
});
