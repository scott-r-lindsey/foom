import type { ReactNode } from "react";
import type { RenderOptions } from "@testing-library/react";
import {
  ErrorPresentation,
  BackgroundErrorMark,
} from "../../../../src/renderer/board/error-presentation";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentsStep } from "../../../../src/renderer/preflight/agents-step";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { installation, report, setupState } from "../../../fixtures/setup";

const render = (ui: ReactNode, options?: RenderOptions) =>
  renderView(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ErrorPresentation>
        {children}
        <BackgroundErrorMark />
      </ErrorPresentation>
    ),
  });

afterEach(cleanup);
const pending: ConfigStatus = {
  folder: "/config",
  available: true,
  pending: null,
  rejected: [{ file: "settings.json", reason: "$: malformed-json" }],
  agentPlugins: [
    {
      id: "fixture",
      name: "Fixture",
      mark: "FT",
      command: "fixture-cli",
      file: "agents/fixture.json",
      state: "rejected",
      reason: "$.launch: invalid",
    },
    {
      id: "broken",
      name: "Broken",
      mark: "BR",
      command: "broken",
      file: "agents/broken.json",
      state: "rejected",
      reason: "$.id: invalid",
    },
  ],
};
function fixture() {
  const save = vi.fn();
  const scan = vi.fn(() => Promise.resolve());
  const saveArguments = vi.fn(() => Promise.resolve());
  let listener: ((status: ConfigStatus) => void) | undefined;
  const unsubscribe = vi.fn();
  const config = {
    status: vi.fn(() => Promise.resolve(pending)),
    decide: vi.fn((): Promise<ConfigStatus> => Promise.resolve({ ...pending, agentPlugins: [] })),
    subscribe: vi.fn((receive: (status: ConfigStatus) => void) => {
      listener = receive;
      return unsubscribe;
    }),
    revert: vi.fn(() => Promise.resolve(pending)),
    openFolder: vi.fn(() => Promise.resolve()),
  };
  const source: SetupSource = {
    config,
    state: () => Promise.resolve(setupState()),
    save: () => Promise.resolve(setupState()),
    scanAgents: () => Promise.resolve(report()),
    changeAgyPlugin: () => Promise.resolve(report()),
    repositories: () => Promise.resolve([]),
    suggestions: () => Promise.resolve([]),
    scan: () => Promise.resolve(null),
    apply: () => Promise.resolve({ repositories: [], failures: [] }),
    subscribe: () => () => {},
    openThemesFolder: () => Promise.resolve(),
  };
  const props = {
    headingRef: { current: null },
    state: setupState(),
    scanning: false,
    scan,
    save,
    saveArguments,
    changePlugin: vi.fn(() => Promise.resolve()),
    source,
    report: report(
      { ...installation("claude"), mcp: true, inline: true },
      { ...installation("codex"), hookState: "not-reviewed" },
    ),
  };
  return {
    props,
    source,
    config,
    scan,
    save,
    saveArguments,
    unsubscribe,
    update: (next: ConfigStatus) => listener?.(next),
  };
}

test("rejected config plugins block launch and show their reason without any approval action", async () => {
  const f = fixture();
  const view = render(<AgentsStep {...f.props} />);
  const card = await screen.findByRole("region", { name: "Fixture" });
  expect(within(card).getByRole("switch")).toHaveProperty("disabled", true);
  expect(within(card).getByRole("textbox")).toBeTruthy();
  expect(within(card).getAllByText("Unavailable")).toHaveLength(3);
  expect(within(card).getByText("Rejected · launch blocked")).toBeTruthy();
  expect(within(card).getByText("$.launch: invalid")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Review…" })).toBeNull();
  expect(screen.getByText("$.id: invalid")).toBeTruthy();
  act(() => f.update({ ...pending, agentPlugins: [] }));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Fixture" })).toBeNull();
  });
  expect(f.scan).toHaveBeenCalledWith(true);
  act(() =>
    f.update({
      ...pending,
      agentPlugins: [
        {
          id: "claude",
          name: "Invalid shadow",
          mark: "X",
          command: "bad",
          file: "agents/claude.json",
          state: "rejected",
        },
      ],
    }),
  );
  const builtin = screen.getByRole("region", { name: "Claude Code" });
  expect(within(builtin).getByText("Built-in")).toBeTruthy();
  expect(within(builtin).getByRole("switch")).toHaveProperty("disabled", false);
  view.unmount();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});

test("status replies after unmount are ignored", async () => {
  const f = fixture();
  let complete: (next: ConfigStatus) => void = () => {};
  f.config.status.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const gone = render(<AgentsStep {...f.props} />);
  gone.unmount();
  await act(async () => {
    complete(pending);
    await Promise.resolve();
  });
});

test("status errors and late rejections are handled", async () => {
  const f = fixture();
  f.config.status.mockRejectedValueOnce(Error("Config unavailable"));
  const view = render(<AgentsStep {...f.props} />);
  expect(await screen.findByText("Unable to load agent settings.")).toBeTruthy();
  view.unmount();
  let fail: (reason: Error) => void = () => {};
  f.config.status.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const gone = render(<AgentsStep {...f.props} />);
  gone.unmount();
  await act(async () => {
    fail(Error("late"));
    await Promise.resolve();
  });
});

test("registry-only agent cards save literal defaults and hook choices, with facts and a collapsed missing row", async () => {
  const f = fixture();
  const agent = {
    id: "fixture",
    name: "Fixture",
    mark: "FT",
    command: "fixture-cli",
    path: "/bin/fixture",
    version: "1.2.3",
    hooks: true,
    mcp: true,
    resume: true,
    inline: false,
    source: "agents/fixture.json",
    bypassArguments: ["--yolo"],
    reason: "Config-authored agent; validated launch manifest.",
  };
  const view = render(
    <AgentsStep
      {...f.props}
      report={report(agent, {
        id: "missing",
        path: null,
        version: null,
        hooks: false,
        reason: "missing",
      })}
      source={undefined}
    />,
  );
  const card = screen.getByRole("region", { name: "Fixture" });
  expect(within(card).queryByText("Approved")).toBeNull();
  expect(within(card).getByText("/bin/fixture")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Screen rules" }));
  expect(f.save).toHaveBeenCalledWith({ agentHooks: { fixture: false } });
  fireEvent.click(within(card).getByRole("button", { name: "Hooks" }));
  expect(f.save).toHaveBeenLastCalledWith({ agentHooks: { fixture: true } });
  fireEvent.click(within(card).getByRole("switch"));
  expect(f.save).toHaveBeenCalledWith({
    agents: { claude: true, codex: true, agy: true, fixture: false },
  });
  fireEvent.change(within(card).getByRole("textbox"), { target: { value: "--yolo\na model\n" } });
  expect(within(card).getByText(/Bypass approvals/)).toBeTruthy();
  fireEvent.blur(within(card).getByRole("textbox"));
  await waitFor(() => {
    expect(f.saveArguments).toHaveBeenCalledWith("fixture", ["--yolo", "a model"]);
  });
  const missing = screen.getByRole("region", { name: "missing" });
  expect(missing.querySelectorAll(".agent-setting")).toHaveLength(0);
  view.rerender(<AgentsStep {...f.props} report={undefined} source={undefined} scanning />);
  expect(screen.getAllByText("Looking…")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Scanning…" })).toHaveProperty("disabled", true);
});

test("setup controls request main's fixed action and refresh status, with failures inline", async () => {
  const f = fixture();
  const change = vi.fn(() => Promise.resolve(report()));
  f.source.changeAgentSetup = change;
  f.props.report = report({
    ...installation("claude"),
    setup: { state: "not-installed", actions: [{ id: "install", label: "Install" }] },
  });
  render(<AgentsStep {...f.props} />);
  const button = screen.getByRole("button", { name: "Install" });
  fireEvent.click(button);
  await waitFor(() => {
    expect(change).toHaveBeenCalledWith("claude", "install");
    expect(button).toHaveProperty("disabled", false);
  });
  change.mockRejectedValueOnce(Error("Setup changed"));
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Unable to update settings.",
  );
});

test.each(["claude", "custom"])(
  "missing %s stays off without saving its preference and follows it after discovery",
  (id) => {
    const f = fixture();
    const agent = { ...installation("claude"), id, name: "Test agent", path: null, version: null };
    const props = { ...f.props, source: undefined, report: report(agent) };
    const view = render(<AgentsStep {...props} />);
    const card = screen.getByRole("region", {
      name: id === "claude" ? "Claude Code" : "Test agent",
    });
    expect(within(card).getByRole("switch")).toHaveProperty("checked", false);
    expect(within(card).getByRole("switch")).toHaveProperty("disabled", true);
    expect(within(card).getByText("Off")).toBeTruthy();
    expect(within(card).getByText("Not found")).toBeTruthy();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.scan).toHaveBeenCalledWith(true);
    const installed = report({ ...agent, path: "/fixture/agent" });
    view.rerender(<AgentsStep {...props} report={installed} />);
    expect(within(card).getByRole("switch")).toHaveProperty("checked", true);
    expect(within(card).getByRole("switch")).toHaveProperty("disabled", false);
    const state = {
      ...props.state,
      settings: {
        ...props.state.settings,
        agents: { ...props.state.settings.agents, [id]: false },
      },
    };
    view.rerender(<AgentsStep {...props} state={state} />);
    expect(within(card).getByText("Not found")).toBeTruthy();
    expect(within(card).getByRole("switch")).toHaveProperty("disabled", true);
    view.rerender(<AgentsStep {...props} state={state} report={installed} />);
    expect(within(card).getByRole("switch")).toHaveProperty("checked", false);
    expect(within(card).getByRole("switch")).toHaveProperty("disabled", false);
    expect(f.save).not.toHaveBeenCalled();
  },
);

test("missing attention replaces the signal control with neutral terse text", () => {
  const f = fixture();
  f.source.changeAgentSetup = vi.fn(() => Promise.resolve(report()));
  render(
    <AgentsStep
      {...f.props}
      report={report({
        ...installation("claude"),
        hooks: false,
        attentionSignal: false,
        setup: { state: "not-installed", actions: [{ id: "install", label: "Install" }] },
        hookState: "not-reviewed",
      })}
    />,
  );
  const card = screen.getByRole("region", { name: "Claude Code" });
  const signal = within(card).getByText("No attention signal");
  expect(signal.className).toBe("");
  expect(within(card).queryByText("Screen rules")).toBeNull();
  expect(within(card).queryByText("Trust review pending")).toBeNull();
  expect(within(card).queryByRole("button", { name: "Hooks" })).toBeNull();
  // Setup can still add the signal, so its actions stay available.
  expect(within(card).getByRole("button", { name: "Install" })).toBeTruthy();
});
