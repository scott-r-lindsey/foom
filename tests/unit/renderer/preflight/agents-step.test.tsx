// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentsStep } from "../../../../src/renderer/preflight/agents-step";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { installation, report, setupState } from "../../../fixtures/setup";

afterEach(cleanup);
const pending: ConfigStatus = {
  folder: "/config",
  available: true,
  uncommitted: 1,
  pending: null,
  changes: [],
  rejected: 1,
  agentPlugins: [
    {
      id: "fixture",
      name: "Fixture",
      mark: "FT",
      command: "fixture-cli",
      file: "agents/fixture.json",
      state: "pending",
      decisionId: "digest",
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
      { ...installation("codex"), codexHookState: "not-reviewed" },
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

test("pending and rejected cards block launch and only request main's trusted review; approvals refresh discovery", async () => {
  const f = fixture();
  const view = render(<AgentsStep {...f.props} />);
  const card = await screen.findByRole("region", { name: "Fixture" });
  expect(within(card).getByRole("switch")).toHaveProperty("disabled", true);
  expect(within(card).getByRole("textbox")).toBeTruthy();
  expect(within(card).getAllByText("Approval required")).toHaveLength(3);
  expect(screen.getByText("$.id: invalid")).toBeTruthy();
  expect(f.config.decide).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole("button", { name: "Review…" }));
  await waitFor(() => {
    expect(f.config.decide).toHaveBeenCalledExactlyOnceWith("allow", "digest");
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Fixture" })).toBeNull();
  });
  expect(f.scan).toHaveBeenCalledWith(true);
  act(() => f.update(pending));
  expect(screen.getByRole("region", { name: "Fixture" })).toBeTruthy();
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

test("review refusal stays blocked, failures surface, and status replies after unmount are ignored", async () => {
  const f = fixture();
  f.config.decide.mockResolvedValueOnce(pending);
  f.config.decide.mockRejectedValueOnce(Error("Plugin replaced"));
  const view = render(<AgentsStep {...f.props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Review…" })).toHaveProperty("disabled", false);
  });
  expect(screen.getByText("Approval pending · launch blocked")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review…" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Plugin replaced");
  view.unmount();
  act(() => f.update(pending));
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

test("status errors and late rejections are handled without granting plugin approval", async () => {
  const f = fixture();
  f.config.status.mockRejectedValueOnce(Error("Config unavailable"));
  const view = render(<AgentsStep {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Config unavailable");
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
    reason: "approved",
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
  expect(within(card).getByText("Approved")).toBeTruthy();
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
