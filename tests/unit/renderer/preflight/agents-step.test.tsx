import { BUILTIN_AGENTS } from "../../../../src/shared/providers/catalog";
import { renderWithErrors as render } from "../../../fixtures/render-with-errors";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentsStep } from "../../../../src/renderer/preflight/agents-step";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { installation, report, setupState } from "../../../fixtures/setup";

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
  expect(card.querySelectorAll(".agent-capability")).toHaveLength(0);
  expect(within(card).queryByText("Unavailable")).toBeNull();
  const icon = within(card).getByRole("img", { name: "Foom config · agents/fixture.json" });
  expect(icon.getAttribute("title")).toBe("Foom config · agents/fixture.json");
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
  expect(within(builtin).queryByRole("img")).toBeNull();
  expect(screen.queryByText("Plugin source")).toBeNull();
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
  expect(screen.getAllByText("Looking…")).toHaveLength(BUILTIN_AGENTS.length);
  expect(screen.getByRole("button", { name: "Re-check This computer" })).toHaveProperty(
    "disabled",
    true,
  );
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
    expect(f.scan).not.toHaveBeenCalled();
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

test("capability chips explain supported capabilities and omit unsupported ones", async () => {
  const f = fixture();
  f.props.report = report(
    {
      ...installation("claude"),
      mcp: true,
      resume: true,
      inline: true,
      source: "agents/custom.json",
    },
    { ...installation("codex"), mcp: false, resume: false, inline: false },
  );
  render(<AgentsStep {...f.props} />);
  const card = await screen.findByRole("region", { name: "Claude Code" });
  for (const [label, hint] of [
    ["MCP", "Foom can orchestrate this agent"],
    ["Resume", "Reopen past conversations"],
    ["Inline", "Runs in scrollback; wheel scrolls history"],
  ]) {
    const chip = within(card).getByText(label ?? "");
    expect(chip.getAttribute("title")).toBe(hint);
    expect(chip.getAttribute("aria-label")).toBe(hint);
  }
  expect(within(card).getByRole("img", { name: "Foom config · agents/custom.json" })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Codex" }).querySelectorAll(".agent-capability"),
  ).toHaveLength(0);
  expect(screen.queryByText("Unavailable")).toBeNull();
});

test.each([true, false])("config source icon does not toggle an agent that is %s", (enabled) => {
  const f = fixture();
  const agents = { claude: enabled, codex: true, agy: true };
  render(
    <AgentsStep
      {...f.props}
      state={setupState({ agents })}
      source={undefined}
      report={report({ ...installation("claude"), source: "agents/custom.json" })}
    />,
  );
  const card = screen.getByRole("region", { name: "Claude Code" });
  const toggle = within(card).getByRole("switch");
  expect(toggle).toHaveProperty("checked", enabled);
  fireEvent.click(within(card).getByRole("img", { name: "Foom config · agents/custom.json" }));
  expect(toggle).toHaveProperty("checked", enabled);
  expect(f.save).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ agents: { ...agents, claude: !enabled } });
});

test("an installed agent without supported capabilities has no capabilities row", () => {
  const f = fixture();
  render(
    <AgentsStep
      {...f.props}
      source={undefined}
      report={report({ ...installation("codex"), mcp: false, resume: false, inline: false })}
    />,
  );
  const card = screen.getByRole("region", { name: "Codex" });
  expect(within(card).getByRole("switch")).toHaveProperty("checked", true);
  expect(within(card).queryByText("Capabilities")).toBeNull();
  expect(card.querySelector(".agent-capabilities")).toBeNull();
});

test("unavailable plugin status offers a bounded rescan from the row", () => {
  const f = fixture();
  f.source.changeAgentSetup = vi.fn(() => Promise.resolve(report()));
  f.props.report = report({ ...installation("agy"), setup: { state: "unavailable", actions: [] } });
  render(<AgentsStep {...f.props} />);
  expect(screen.getByText("Plugin · Status unavailable")).toBeTruthy();
  f.scan.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
  expect(f.scan).toHaveBeenCalledWith(true);
});

test.each([false, true])(
  "retains main's setup receipt until an explicit scan (machine=%s)",
  async (machine) => {
    const f = fixture();
    const installationWithSetup = {
      ...installation("claude"),
      setup: {
        state: "not-installed" as const,
        actions: [{ id: "install", label: "Install" }],
        result: "Installed Foom observer v5 · enabled",
      },
    };
    f.source.changeAgentSetup = vi.fn(() => Promise.resolve(report(installationWithSetup)));
    f.props.report = report(installationWithSetup);
    const view = render(<AgentsStep {...f.props} machine={machine} />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Installed Foom observer v5 · enabled",
    );
    if (machine) {
      view.rerender(<AgentsStep {...f.props} machine receiptEpoch={1} />);
      expect(screen.queryByRole("status")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
      expect(await screen.findByRole("status")).toHaveProperty(
        "textContent",
        "Installed Foom observer v5 · enabled",
      );
    }
    fireEvent.click(
      screen.getByRole("button", {
        name: machine ? "Re-check Claude Code" : "Re-check This computer",
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  },
);

test("local Install requires a click, retains its terminal, and reloads only its row", async () => {
  const f = fixture();
  f.config.status.mockResolvedValue({ ...pending, agentPlugins: [] });
  const installs = new Map<string, string>();
  const install = vi.fn((id?: string) => {
    if (id) installs.set(`local:${id}`, "local-install");
    return Promise.resolve({
      available: ["claude"],
      ...(id ? { recipeSession: "local-install" } : {}),
    });
  });
  f.source.localAgentInstall = install;
  f.source.installs = {
    sessions: () => installs,
    hasSessions: () => installs.size > 0,
    running: () => Promise.resolve(false),
    close: () => Promise.resolve(),
    dispose: () => {},
  };
  const listeners = new Set<(exit: { exited: boolean; code?: number }) => void>();
  f.source.hostTerminal = {
    createView: () => ({
      mount: () => () => {},
      open: () => Promise.resolve(),
      hide: () => Promise.resolve(),
      focus: () => {},
      subscribe: () => () => {},
      getSnapshot: () => ({
        status: "",
        state: "quiet_ok",
        visible: true,
        attaching: false,
        toggleLabel: "",
        toggleDisabled: false,
        restartDisabled: false,
      }),
    }),
    observe: (_id, receive) => {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
  };
  const view = render(
    <AgentsStep {...f.props} machine report={report({ ...installation("claude"), path: null })} />,
  );
  const button = await screen.findByRole("button", { name: "Install" });
  expect(install).toHaveBeenCalledExactlyOnceWith();
  fireEvent.click(button);
  await screen.findByRole("region", { name: "Install terminal" });
  expect(install).toHaveBeenLastCalledWith("claude");
  expect(button).toHaveProperty("disabled", true);
  act(() => {
    for (const receive of listeners) receive({ exited: true, code: 7 });
  });
  expect(screen.getByText("Failed · exit code 7")).toBeTruthy();
  expect(f.scan).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(listeners.size).toBe(0);
});

test("a failed local installer launch reports a fixed failure and can be retried", async () => {
  const f = fixture();
  f.source.localAgentInstall = vi.fn((id?: string) =>
    id ? Promise.reject(new Error("private")) : Promise.resolve({ available: ["claude"] }),
  );
  render(
    <AgentsStep {...f.props} machine report={report({ ...installation("claude"), path: null })} />,
  );
  const button = await screen.findByRole("button", { name: "Install" });
  fireEvent.click(button);
  await screen.findByText("Unable to start installer");
  expect(button).toHaveProperty("disabled", false);
});
