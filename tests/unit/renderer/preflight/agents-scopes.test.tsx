import type { AgentPermissionLevel } from "../../../../src/shared/agent-permissions";
import { ApplicationError } from "../../../../src/shared/application-errors";
import type { DataViews, DataViewApi } from "../../../../src/shared/data-views";
// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithErrors as render } from "../../../fixtures/render-with-errors";
import { AgentsScopes } from "../../../../src/renderer/preflight/agents-scopes";
import type { HostRow, HostsAction, HostsState } from "../../../../src/shared/registered-hosts.d";
import type { Settings, SettingsPatch } from "../../../../src/shared/setup";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type {
  HostTerminalAction,
  SetupSource,
} from "../../../../src/renderer/preflight/setup-source.d";
import { installation, report, setupState } from "../../../fixtures/setup";

vi.mock("../../../../src/renderer/preflight/host-terminal", () => ({
  HostTerminal: ({ id, finished }: { id: string; finished: (id: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        finished(id);
      }}
    >
      Finish install {id}
    </button>
  ),
}));
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
  const savePermission = vi.fn((_scope: string, _id: string, _level: AgentPermissionLevel | null) =>
    Promise.resolve(),
  );
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
  let registrationsChanged:
    | ((registrations: NonNullable<Settings["registeredHosts"]>) => void)
    | undefined;
  function View({ codexLevels }: { codexLevels?: readonly AgentPermissionLevel[] }) {
    const [scope, setScope] = useState(initial);
    const [state, setState] = useState(() =>
      setupState({
        registeredHosts: rows,
        agents: { claude: true, codex: true, agy: true, pi: true, opencode: true, copilot: false },
      }),
    );
    registrationsChanged = (registeredHosts) => {
      setState((previous) => ({
        ...previous,
        settings: { ...previous.settings, registeredHosts },
      }));
    };
    return (
      <AgentsScopes
        scope={scope}
        selectScope={setScope}
        source={source}
        state={state}
        report={{
          ...report(installation("claude"), {
            ...installation("codex", false),
            ...(codexLevels ? { permissionLevels: codexLevels } : {}),
          }),
          checkedAt: 1000,
        }}
        scanning={false}
        scan={scan}
        save={(patch) => {
          save(patch);
          setState({ ...state, settings: { ...state.settings, ...patch } });
        }}
        saveArguments={args}
        savePermission={async (scope, id, level) => {
          await savePermission(scope, id, level);
          setState((previous) => ({
            ...previous,
            settings: {
              ...previous.settings,
              agentPermissions: {
                ...previous.settings.agentPermissions,
                [scope]: { [id]: level === null ? null : { level } },
              },
            },
          }));
        }}
        changePlugin={() => Promise.resolve()}
        headingRef={{ current: null }}
      />
    );
  }
  return {
    View,
    source,
    registrations: (registrations: NonNullable<Settings["registeredHosts"]>) =>
      registrationsChanged?.(registrations),
    rows,
    api,
    scan,
    save,
    args,
    openFolder,
    savePermission,
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
  expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
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
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  f.api.mockResolvedValueOnce({ hosts: [], locations: [], preflightSaveFailed: true });
  fireEvent.click(screen.getByRole("button", { name: "Re-check Build" }));
  await screen.findByText("Unable to check agent settings");
  expect(screen.getByRole("region", { name: "Codex" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
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
  expect(screen.getByRole("combobox", { name: "Machine" })).toHaveProperty("value", "local");
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
  expect(
    within(screen.getByRole("combobox", { name: "Machine" })).getAllByRole("option"),
  ).toHaveLength(13);
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:machine-11" },
  });
  expect(screen.getAllByText("machine-11")).toHaveLength(2);
  expect(f.api).toHaveBeenCalledExactlyOnceWith({ action: "list" });
  expect(f.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Global" }));
  expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Machines" }));
  expect(screen.getByRole("combobox", { name: "Machine" })).toHaveProperty(
    "value",
    "host:machine-11",
  );
});

function stream(f: ReturnType<typeof fixture>) {
  const data: DataViews = {
    settings: setupState(),
    hosts: { hosts: f.rows, locations: [] },
    agents: report(),
    repositories: [],
    worktrees: [],
    sessions: [],
    config: { folder: "/config", available: true, pending: null, rejected: [] },
    environment: {
      lists: { all: [], claude: [], codex: [], agy: [] },
      windows: false,
      secrets: false,
    },
    fonts: [],
    sounds: [],
    readiness: { git: "ready", platform: "linux", forges: [] },
  };
  let revision = 1;
  let failed = false;
  const emit = new Map<string, () => void>();
  const views: DataViewApi = {
    subscribeView(view, params, receive) {
      emit.set(view, () => {
        const base = { id: "hosts", view, params, generation: 1, revision };
        receive(failed ? { ...base, error: "unavailable" } : { ...base, data: data[view] });
      });
      return () => {};
    },
  };
  f.source.views = views;
  return {
    push: (hosts = f.rows, nextRevision = revision + 1, error = false) => {
      data.hosts = { hosts, locations: [] };
      revision = nextRevision;
      failed = error;
      emit.get("hosts")?.();
    },
  };
}
test("host pushes remove a selected machine immediately and stale revisions cannot restore it", async () => {
  const f = fixture("host:worker");
  const events = stream(f);
  render(<f.View />);
  act(() => {
    events.push();
  });
  await screen.findByRole("region", { name: "Codex" });
  act(() => {
    events.push([]);
  });
  expect(screen.getByRole("combobox", { name: "Machine" })).toHaveProperty("value", "local");
  expect(screen.queryByRole("option", { name: "Build" })).toBeNull();
  act(() => {
    events.push(f.rows, 1);
  });
  expect(screen.queryByRole("option", { name: "Build" })).toBeNull();
  expect(f.api).not.toHaveBeenCalled();
});
test("machine actions wait for the initial subscription and errors retain disabled cached cards", async () => {
  const f = fixture("local");
  const events = stream(f);
  render(<f.View />);
  expect(screen.getByRole("button", { name: "Re-check This computer" })).toHaveProperty(
    "disabled",
    true,
  );
  act(() => {
    events.push();
  });
  await screen.findByRole("option", { name: "Build" });
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:worker" },
  });
  act(() => {
    events.push(f.rows, 3, true);
  });
  await screen.findByText("Unable to load hosts");
  expect(screen.getByRole("button", { name: "Re-check Build" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("region", { name: "Codex" })).toBeTruthy();
  act(() => {
    events.push(f.rows, 4);
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Re-check Build" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

test("a fresh list cannot recreate a removed machine from an older settings snapshot", async () => {
  const f = fixture("host:worker");
  f.api.mockResolvedValueOnce({ hosts: [], locations: [] });
  render(<f.View />);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Machine" })).toHaveProperty("value", "local");
  });
  expect(screen.queryByRole("button", { name: "Re-check Build" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Build" })).toBeNull();
});

test.each([
  ["install-plugin", "agy", "Antigravity", "Install plugin"],
  ["sign-in", "codex", "Codex", "Sign in"],
] as const)(
  "the %s terminal attaches inside its machine agent card",
  async (operation, tool, name, action) => {
    const f = fixture("host:worker");
    const recipe: HostTerminalAction = { action: "recipe", host: "worker", tool, operation };
    f.source.installs = {
      sessions: () => new Map([["worker", "inline"]]),
      hostActions: () => new Map([["inline", recipe]]),
      hasSessions: () => true,
      running: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      dispose: () => {},
    };
    f.source.hostTerminal = {
      createView: () => {
        throw new Error("Mocked terminal");
      },
      observe: () => () => {},
    };
    render(<f.View />);
    const card = await screen.findByRole("region", { name });
    const finish = within(card).getByRole("button", { name: "Finish install inline" });
    const start = within(card).getByRole("button", { name: action });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(finish);
    await waitFor(() => {
      expect(start).toHaveProperty("disabled", false);
    });
  },
);

test.each([false, true])(
  "selected machine retains its Settings install and refreshes after exit (failure %s)",
  async (failed) => {
    const f = fixture("host:worker");
    f.source.installs = {
      sessions: () => new Map([["worker", "install-one"]]),
      hasSessions: () => true,
      running: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      dispose: () => {},
    };
    f.source.hostTerminal = {
      createView: () => {
        throw new Error("Mocked terminal");
      },
      observe: () => () => {},
    };
    render(<f.View />);
    const finish = await screen.findByRole("button", { name: "Finish install install-one" });
    f.api.mockClear();
    if (failed) f.api.mockRejectedValueOnce(new Error("fixture refresh failed"));
    fireEvent.click(finish);
    await waitFor(() => {
      expect(f.api).toHaveBeenCalledExactlyOnceWith({ action: "list" });
    });
    if (failed) await screen.findByText("Unable to load hosts");
    fireEvent.click(screen.getByRole("tab", { name: "Global" }));
    expect(screen.queryByRole("button", { name: "Finish install install-one" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Machines" }));
    await screen.findByRole("button", { name: "Finish install install-one" });
  },
);

test("permission edits use the visible scope and preserve the saved choice on refusal", async () => {
  const f = fixture();
  render(<f.View />);
  const select = () => screen.getByRole("combobox", { name: "Codex permission level" });
  expect(select()).toHaveProperty("value", "");
  fireEvent.change(select(), { target: { value: "workspace" } });
  await waitFor(() => {
    expect(select()).toHaveProperty("value", "workspace");
  });
  expect(select().getAttribute("aria-description")).toContain("Git fetch and commit");
  expect(f.savePermission).toHaveBeenLastCalledWith("global", "codex", "workspace");
  fireEvent.click(screen.getByRole("tab", { name: "Machines" }));
  expect(select()).toHaveProperty("value", "");
  expect(within(select()).getByText("Use Global · Workspace")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host:worker" },
  });
  f.savePermission.mockRejectedValueOnce(new ApplicationError("agent-permission-conflict"));
  fireEvent.change(select(), { target: { value: "full" } });
  await screen.findByText(/Remove permission options from Settings/);
  expect(f.savePermission).toHaveBeenLastCalledWith("host:worker", "codex", "full");
  expect(select()).toHaveProperty("value", "");
});

test("an unavailable saved level remains visible alongside supported choices and reset", async () => {
  const f = fixture();
  const view = render(<f.View />);
  const selector = screen.getByRole("combobox", {
    name: "Codex permission level",
  });
  fireEvent.change(selector, { target: { value: "workspace" } });
  await waitFor(() => {
    expect(selector).toHaveProperty("value", "workspace");
  });
  view.rerender(<f.View codexLevels={["ask", "full"]} />);
  expect(selector).toHaveProperty("value", "workspace");
  expect(within(selector).getByRole("option", { name: "Workspace (unavailable)" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(within(selector).getByRole("option", { name: "Ask" })).toHaveProperty("disabled", false);
  fireEvent.change(selector, { target: { value: "" } });
  await waitFor(() => {
    expect(f.savePermission).toHaveBeenLastCalledWith("global", "codex", null);
    expect(selector).toHaveProperty("value", "");
  });
});
