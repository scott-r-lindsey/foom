// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithErrors as render } from "../../../fixtures/render-with-errors";
import { AgentsScopes } from "../../../../src/renderer/preflight/agents-scopes";
import type { HostRow, HostsAction, HostsState } from "../../../../src/shared/registered-hosts.d";
import type { SettingsPatch } from "../../../../src/shared/setup";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { installation, report, setupState } from "../../../fixtures/setup";

afterEach(cleanup);
function fixture(initial = "global", initialHosts?: readonly HostRow[]) {
  const facts = {
    codeFolder: "/code",
    version: "0.1.0",
    sessions: 0,
    cores: 4,
    load: [0, 0, 0],
    memoryTotal: 1000,
    memoryAvailable: 500,
    agents: [
      {
        id: "claude",
        state: "ready",
        signIn: "signed-in",
        details: { path: "/bin/claude", version: "2.3.1", capabilities: ["Hooks", "MCP"] },
      },
      { id: "codex", state: "ready", signIn: "signed-out" },
      {
        id: "agy",
        state: "ready",
        details: { path: "/bin/agy", version: "", capabilities: [], plugin: "not-installed" },
      },
      { id: "pi", state: "missing" },
      { id: "opencode", state: "unable" },
    ],
  } as const;
  const rows: readonly HostRow[] = initialHosts ?? [
    {
      host: "worker",
      nickname: "Build",
      codeFolder: "/code",
      result: { ok: true, facts },
      observation: {
        checkedAt: 1,
        preflight: {
          ssh: { state: "pass" },
          platform: { state: "pass" },
          artifact: { state: "pass" },
          result: { ok: true, facts },
          repositories: [],
        },
      },
      recipes: [
        { tool: "codex", install: false, signIn: true },
        { tool: "agy", install: false, signIn: false, pluginInstall: true },
        { tool: "pi", install: true, signIn: false },
      ],
    },
  ];
  const api = vi.fn(
    (_action: HostsAction): Promise<HostsState> => Promise.resolve({ hosts: rows, locations: [] }),
  );
  const scan = vi.fn(() => Promise.resolve());
  const save = vi.fn((_patch: SettingsPatch) => {});
  const args = vi.fn(() => Promise.resolve());
  const openFolder = vi.fn(() => Promise.resolve());
  let configChanged:
    | ((next: Awaited<ReturnType<NonNullable<SetupSource["config"]>["status"]>>) => void)
    | undefined;
  const config = {
    status: vi.fn(() =>
      Promise.resolve({
        folder: "/config",
        available: true,
        pending: null,
        rejected: [],
        agentPlugins: [
          {
            id: "bad",
            name: "Bad",
            mark: "BD",
            command: "bad",
            file: "agents/bad.json",
            state: "rejected",
            reason: "invalid",
          },
        ],
      } as const),
    ),
    openFolder,
    decide: vi.fn(),
    subscribe: vi.fn((listener: (next: ConfigStatus) => void) => {
      configChanged = listener;
      return vi.fn();
    }),
  } satisfies NonNullable<SetupSource["config"]>;
  const source: SetupSource = {
    hosts: api,
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
  function View() {
    const [scope, setScope] = useState(initial);
    const [state, setState] = useState(() =>
      setupState({
        agents: { claude: true, codex: true, agy: true, pi: true, opencode: true, copilot: false },
      }),
    );
    return (
      <AgentsScopes
        scope={scope}
        selectScope={setScope}
        source={source}
        state={state}
        report={{
          ...report(installation("claude"), installation("codex", false)),
          checkedAt: 1000,
        }}
        scanning={false}
        scan={scan}
        save={(patch) => {
          save(patch);
          setState({ ...state, settings: { ...state.settings, ...patch } });
        }}
        saveArguments={args}
        changePlugin={() => Promise.resolve()}
        headingRef={{ current: null }}
      />
    );
  }
  return {
    View,
    api,
    scan,
    save,
    args,
    openFolder,
    config,
    changed: () =>
      configChanged?.({
        folder: "/config",
        available: true,
        pending: null,
        rejected: [],
        agentPlugins: [],
      }),
  };
}
test("Global owns enablement and defaults; navigation and cached machine reads never check", async () => {
  const f = fixture();
  render(<f.View />);
  await screen.findByText("agents/bad.json");
  expect(f.api).toHaveBeenCalledExactlyOnceWith({ action: "list" });
  expect(f.scan).not.toHaveBeenCalled();
  expect(screen.getByText(/Rejected · launch blocked · invalid/)).toBeTruthy();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText("Ready")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Attach hooks" }));
  expect(f.save).toHaveBeenCalledWith({ hooks: false });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Claude Code" }));
  expect(f.save.mock.lastCall?.[0]).toMatchObject({ agents: { claude: false } });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Global" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Global" }), { key: "ArrowRight" });
  expect(screen.getByRole("combobox", { name: "Machine" })).toHaveProperty("value", "local");
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:worker" },
  });
  expect(screen.queryByRole("region", { name: "Claude Code" })).toBeNull();
  expect(screen.queryByText(/Off:/)).toBeNull();
  expect(f.api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("tab", { name: "Global" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Claude Code" }));
  const input = screen.getByLabelText("Claude Code default arguments");
  fireEvent.change(input, { target: { value: "--model=example" } });
  fireEvent.blur(input);
  await waitFor(() => {
    expect(f.args).toHaveBeenCalledWith("claude", ["--model=example"]);
  });
  fireEvent.click(screen.getByRole("button", { name: "Open config folder" }));
  expect(f.openFolder).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("tab", { name: "Machines" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "local" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Re-check This computer" }));
  expect(f.scan).toHaveBeenCalledWith(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:worker" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Re-check Build" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "preflight",
      host: "worker",
      codeFolder: "/code",
    });
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "local" },
  });
  expect(screen.queryByLabelText("Claude Code default arguments")).toBeNull();
  expect(screen.getByRole("region", { name: "Claude Code" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Re-check Claude Code" }));
  expect(f.scan).toHaveBeenCalledWith(true, "claude");
  act(() => f.changed());
  expect(f.scan).toHaveBeenCalledWith(true);
});
test("host cards show facts, reload only explicit targets and dispatch recipes", async () => {
  const f = fixture("host:worker");
  render(<f.View />);
  await screen.findByRole("region", { name: "Claude Code" });
  expect(screen.getByText("2.3.1")).toBeTruthy();
  expect(screen.getByText("/bin/claude")).toBeTruthy();
  expect(screen.getByText("Signed out")).toBeTruthy();
  expect(screen.getByText("Not found")).toBeTruthy();
  expect(screen.getByText("Unable to check")).toBeTruthy();
  expect(f.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Re-check Claude Code" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "reload",
      host: "worker",
      target: { kind: "tool", tool: "claude" },
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "recipe",
      host: "worker",
      tool: "codex",
      operation: "sign-in",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "recipe",
      host: "worker",
      tool: "pi",
      operation: "install",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "recipe",
      host: "worker",
      tool: "agy",
      operation: "install-plugin",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Re-check Build" }));
  await waitFor(() => {
    expect(f.api).toHaveBeenCalledWith({
      action: "preflight",
      host: "worker",
      codeFolder: "/code",
    });
  });
});
test("offline and never-checked hosts expose cached state with disabled actions", async () => {
  const f = fixture("host:offline", [
    { host: "offline", codeFolder: "/code", result: { ok: false, reason: "unreachable" } },
    { host: "new", codeFolder: "/code" },
  ]);
  render(<f.View />);
  await screen.findByRole("option", { name: "offline · Offline" });
  expect(screen.getByText("Offline · Not checked")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Re-check offline" })).toHaveProperty("disabled", true);
  for (const button of screen.getAllByRole("button", {
    name: /Re-check (Claude|Codex|Antigravity|Pi|OpenCode)/,
  }))
    expect(button).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:new" },
  });
  expect(screen.getAllByText("Not checked").length).toBeGreaterThan(1);
  expect(f.api).toHaveBeenCalledTimes(1);
});
test("reports failed reads and actions without discarding cached cards; pending work is named", async () => {
  const f = fixture("host:worker");
  render(<f.View />);
  await screen.findByRole("region", { name: "Codex" });
  f.api.mockRejectedValueOnce(new Error("fixture"));
  fireEvent.click(screen.getByRole("button", { name: "Re-check Build" }));
  await screen.findByText("Unable to check agent settings");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  f.api.mockResolvedValueOnce({ hosts: [], locations: [], recipeFailure: "recipe-unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Recipe unavailable for this host");
  expect(screen.getByRole("region", { name: "Codex" })).toBeTruthy();
});
test("removed scope and list/config failures remain reviewable", async () => {
  const f = fixture("host:removed");
  f.api.mockRejectedValueOnce(new Error("fixture"));
  f.config.status.mockRejectedValueOnce(new Error("fixture"));
  render(<f.View />);
  await screen.findByText("Unable to load hosts");
  expect(screen.getByText("Host no longer registered.")).toBeTruthy();
});

test("a disposed catalog subscription cannot start a scan and folder failures remain actionable", async () => {
  const f = fixture();
  const view = render(<f.View />);
  await screen.findByText("agents/bad.json");
  f.openFolder.mockRejectedValueOnce(new Error("fixture"));
  fireEvent.click(screen.getByRole("button", { name: "Open config folder" }));
  await screen.findByText("Unable to open config folder");
  view.unmount();
  act(() => {
    f.changed();
  });
  expect(f.scan).not.toHaveBeenCalled();
});

test("machine picker scales to twelve registered hosts and keeps navigation read-only", async () => {
  const f = fixture(
    "local",
    Array.from({ length: 12 }, (_, index) => ({
      host: `machine-${String(index)}`,
      codeFolder: "/code",
    })),
  );
  render(<f.View />);
  await screen.findByRole("option", { name: "machine-11" });
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getAllByRole("option")).toHaveLength(13);
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:machine-11" },
  });
  expect(screen.getAllByText("machine-11")).toHaveLength(2);
  expect(f.api).toHaveBeenCalledExactlyOnceWith({ action: "list" });
  expect(f.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Global" }));
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Machines" }));
  expect(screen.getByRole("combobox")).toHaveProperty("value", "host:machine-11");
});
