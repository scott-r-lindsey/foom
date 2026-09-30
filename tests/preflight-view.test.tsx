// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { message } from "../src/renderer/preflight-evaluator";
import { Preflight } from "../src/renderer/preflight-view";
import type { SetupSource } from "../src/renderer/setup-source.d";
import type {
  ApiProvider,
  ModelList,
  ProbeFailure,
  ProbeResult,
  ProbeUpdate,
} from "../src/shared/inference";
import type { SettingsPatch, SetupState } from "../src/shared/setup";
import type { AgentReport } from "../src/shared/workspace";
import type { Repository } from "../src/shared/worktrees";
import { installation, report, setupState } from "./fixtures/setup";

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
    addRepository: vi.fn(() => {
      const repository = { path: "/code/app", name: "app" };
      repositories.push(repository);
      return Promise.resolve<Repository | null>(repository);
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
  expect(screen.getByText("Hooks")).toBeTruthy();
  expect(screen.getByText("Notify")).toBeTruthy();
  expect(screen.getByText("Unverified hook support; using output evaluation.")).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/Codex/));
  await waitFor(() => {
    expect(source.save).toHaveBeenCalledWith({
      agents: { claude: true, codex: false, agy: true },
    });
  });
  await screen.findByText("2 agents ready");
  fireEvent.click(screen.getByRole("checkbox", { name: /Attach Foom's hooks/ }));
  await waitFor(() => {
    expect(screen.getAllByText("Evaluator")).toHaveLength(2);
  });
  fireEvent.click(button("Scan again"));
  expect(source.scanAgents).toHaveBeenLastCalledWith(true);
  await screen.findByText("Scan again");

  fireEvent.click(button("Continue"));
  expect(screen.getByText("No repositories yet.")).toBeTruthy();
  fireEvent.click(button("Add repository…"));
  await screen.findByText("/code/app");
  expect(screen.getByText("/home/me/.foom/worktrees/app/feat/search")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /next to each repository/ }));
  await screen.findByText("/code/app-feat/search");

  fireEvent.click(button("Continue"));
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

test("with no agents installed, go / no-go holds and links back to each fix", async () => {
  const none = report(installation("claude", false), installation("codex", false));
  const source = fake(setupState(), none);
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("No agents ready yet");
  expect(screen.getAllByText("Not found")).toHaveLength(3);
  expect(screen.getAllByRole("checkbox", { name: /claude|codex|agy/ })[0]).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getAllByText(/isn't on your PATH/, { selector: "p" })).toHaveLength(3);
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  expect(screen.getByText("Hold. Something needs fixing.")).toBeTruthy();
  expect(button("Launch")).toHaveProperty("disabled", true);
  expect(screen.getAllByText("NO-GO")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[1] as HTMLElement);
  expect(screen.getByText("Where do your repos live?")).toBeTruthy();
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
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
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

  fireEvent.click(button("Replace"));
  expect(screen.getByLabelText("API key")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
    target: { value: "openai" },
  });
  expect(screen.getByRole("textbox", { name: "Model" })).toHaveProperty("value", "gpt-4.1-mini");
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
    target: { value: "anthropic" },
  });
  fireEvent.click(button("Remove"));
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
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
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
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
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
  source.addRepository.mockRejectedValueOnce(new Error("Repository must be a Git work tree"));
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  await screen.findByRole("alert");
  fireEvent.click(button("Start preflight"));
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Add repository…"));
  expect((await screen.findByRole("alert")).textContent).toBe("Repository must be a Git work tree");
  source.addRepository.mockResolvedValueOnce(null);
  fireEvent.click(button("Add repository…"));
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
  await source.addRepository();
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  await screen.findByText("3 agents ready");
  for (let step = 0; step < 3; step++) fireEvent.click(button("Continue"));
  await screen.findByText("All stations go.");
  source.save.mockRejectedValueOnce(new Error("Disk full"));
  fireEvent.click(button("Launch"));
  await screen.findByText("Disk full");
  expect(screen.queryByRole("dialog")).toBeNull();
});

async function toLocal(source: ReturnType<typeof fake>) {
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
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

test("the endpoint's model list reports failures in Foom's words", async () => {
  const source = fake(setupState());
  source.models.mockResolvedValue({
    ok: false,
    failure: "refused",
    message: "Connection refused: nothing is listening on 127.0.0.1:11434",
  });
  render(<Preflight source={source} initial={setupState()} onLaunched={vi.fn()} />);
  fireEvent.click(button("Start preflight"));
  fireEvent.click(button("Continue"));
  fireEvent.click(button("Continue"));
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
