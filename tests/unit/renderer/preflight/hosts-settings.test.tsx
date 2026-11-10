import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type { TerminalViewSource } from "../../../../src/renderer/terminal/terminal-view-source.d";
import { chmod } from "node:fs/promises";
// @vitest-environment jsdom
import { restartedBrewHost } from "../../main/setup/hosts-saved-fixture";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  HostsSettings,
  RepositoryHosts,
  hostProgressText,
} from "../../../../src/renderer/preflight/hosts-settings";
import type {
  HostFailure,
  HostCheckProgress,
  HostPreflight,
  HostsAction,
  HostsState,
} from "../../../../src/shared/registered-hosts.d";
const remoteReads = vi.hoisted(() => ({ management: vi.fn(), inventory: vi.fn() }));
vi.mock("../../../../src/main/terminals/remote-transport", () => ({
  remoteManagement: remoteReads.management,
  remoteInventory: remoteReads.inventory,
}));
const facts = {
  codeFolder: "/home/worker/code",
  version: "0.1.0",
  sessions: 2,
  cores: 8,
  load: [1, 2, 3],
  memoryTotal: 8 * 1024 ** 3,
  memoryAvailable: 4 * 1024 ** 3,
  folder: { state: "pass" as const },
  requirements: {
    distro: "debian" as const,
    libc: "supported" as const,
    packageManager: "apt" as const,
  },
  tools: [
    { id: "git", state: "ready" as const, signIn: "unknown" as const },
    { id: "gh", state: "ready" as const, signIn: "signed-in" as const },
  ],
  agents: [{ id: "claude", state: "ready" as const, signIn: "signed-in" as const }],
};
const host = {
  host: "worker",
  codeFolder: facts.codeFolder,
  foreignWorktrees: 2,
  foreignSessions: 1,
  result: { ok: true as const, facts },
};
const preflight: HostPreflight = {
  ssh: { state: "pass" },
  platform: { state: "pass" },
  artifact: { state: "pass" },
  result: host.result,
  repositories: [
    {
      repository: "/local/project",
      origin: { state: "pass" },
      checkout: { ...host.result, checkout: { path: "/remote/project", state: "absent" } },
    },
  ],
};
const initial: HostsState = { hosts: [host], locations: [], preflight };
function saved(state: HostsState): HostsState {
  return {
    ...state,
    hosts: state.hosts.map((entry) => ({
      ...entry,
      ...(state.preflight
        ? { observation: { checkedAt: 1700000000000, preflight: state.preflight } }
        : {}),
    })),
  };
}
function expandHosts() {
  for (const button of screen.queryAllByRole("button", { name: /^Expand /u }))
    fireEvent.click(button);
  for (const summary of screen.queryAllByText("Host facts")) fireEvent.click(summary);
}
async function mount(
  state: HostsState = initial,
  extra: Pick<SetupSource, "hostTerminal" | "installs"> = {},
) {
  state = saved(state);
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(state);
  const view = render(<HostsSettings source={{ hosts: api, ...extra }} headingRef={createRef()} />);
  const first = state.hosts[0];
  if (first) await screen.findByRole("region", { name: first.host });
  expandHosts();
  return { api, ...view };
}
afterEach(cleanup);
test("Add host enrolls then runs full preflight, without separate connection/folder tests", async () => {
  let state: HostsState = { hosts: [], locations: [] };
  const api = vi.fn((action: HostsAction) => {
    if (action.action === "add") state = initial;
    return Promise.resolve(state);
  });
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByText("No hosts");
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: " worker " } });
  fireEvent.change(screen.getByLabelText("Code folder"), { target: { value: "~/code" } });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByRole("region", { name: "worker" });
  await screen.findByText("Pass · Reachable");
  expect(screen.queryByLabelText("SSH host")).toBeNull();
  expect(api).toHaveBeenCalledWith({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(api).toHaveBeenCalledWith({
    action: "preflight",
    host: "worker",
    codeFolder: host.codeFolder,
  });
});
test("all independent checks, resource facts, refresh, folder editing, End and removal remain available", async () => {
  const { api } = await mount();
  await screen.findByText("Pass · Host key trusted");
  for (const text of [
    "Pass · Supported",
    "Pass · In this build",
    "Pass · Valid",
    "Claude Code",
    "Pass · Reachable",
    "2 other worktrees",
    "8.0 GiB",
    "4.0 GiB",
    "1.00 · 2.00 · 3.00",
  ])
    expect(screen.getByText(text)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh facts" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({ action: "refresh", host: "worker" });
  });
  await waitFor(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Check capabilities" }).disabled,
    ).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "preflight",
      host: "worker",
      codeFolder: host.codeFolder,
    });
  });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change folder" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  fireEvent.change(screen.getByLabelText("Code folder"), { target: { value: "~/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Code folder")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  fireEvent.change(screen.getByLabelText("Code folder"), { target: { value: "~/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "change-folder",
      host: "worker",
      codeFolder: "~/new",
    });
  });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "End…" }).disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "End…" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({ action: "end", host: "worker" });
  });
  expect(screen.queryByRole("button", { name: "Clone here" })).toBeNull();
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(false);
  });
  api.mockResolvedValue({ hosts: [], locations: [] });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("No hosts");
});
test("partial facts retain passes and expose Create plus available Install and Sign in actions", async () => {
  const partialFacts = {
    ...facts,
    folder: { state: "fail" as const, reason: "folder-missing" as const },
    tools: [
      { id: "git", state: "missing" as const, signIn: "unknown" as const },
      { id: "gh", state: "ready" as const, signIn: "signed-out" as const },
    ],
    agents: [
      { id: "codex", state: "missing" as const },
      { id: "pi", state: "unable" as const },
      { id: "custom", state: "ready" as const },
    ],
  };
  const result = { ok: true as const, facts: partialFacts };
  const { api } = await mount({
    ...initial,
    hosts: [
      {
        ...host,
        result,
        recipes: [
          { tool: "git", install: true, signIn: false },
          { tool: "gh", install: true, signIn: true },
        ],
      },
    ],
    preflight: {
      ...preflight,
      result,
      repositories: [
        {
          repository: "/local/project",
          origin: { state: "fail", reason: "origin-auth" },
          checkout: {
            ...host.result,
            checkout: { path: "/remote/project", state: "absent" as const },
          },
        },
      ],
    },
  });
  await screen.findByText("Pass · Host key trusted");
  expect(screen.getByText(/Code folder does not exist · folder-missing/u)).toBeTruthy();
  expect(screen.getByLabelText("Git access fixes").textContent).toContain("Use HTTPS through gh");
  expect(screen.getByText("Use HTTPS through gh").getAttribute("title")).toBe(
    "Configure the host's Git to use HTTPS through gh",
  );
  expect(screen.queryByRole("button", { name: "Install codex" })).toBeNull();
  expect(screen.getByText("Unable to check")).toBeTruthy();
  for (const [button, action] of [
    ["Create", { action: "create-folder", host: "worker" }],
    ["Install git", { action: "recipe", host: "worker", tool: "git", operation: "install" }],
    ["Sign in gh", { action: "recipe", host: "worker", tool: "gh", operation: "sign-in" }],
  ] as const) {
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: button }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(action);
    });
  }
  api.mockResolvedValue({ ...initial, recipeFailure: "recipe-unavailable" });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign in gh" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in gh" }));
  await screen.findByText("Recipe unavailable for this host");
});
test.each([false, true])(
  "Mac observations: CLT, protected folder and power warnings (%s)",
  async (ready) => {
    const result = {
      ok: true as const,
      facts: {
        ...facts,
        requirements: {
          distro: "darwin" as const,
          libc: "supported" as const,
          packageManager: "brew" as const,
          mac: { commandLineTools: ready, protectedFolder: !ready, staysAwake: ready },
        },
      },
    };
    await mount({ ...initial, hosts: [{ ...host, result }], preflight: { ...preflight, result } });
    await screen.findByText("Command Line Tools");
    expect(
      screen.getByText(ready ? "Pass · Stays awake" : "Warning · Sleeps when idle"),
    ).toBeTruthy();
    if (!ready) {
      expect(screen.getByText("Do this on the Mac")).toBeTruthy();
      expect(screen.getByText("Warning · Protected folder").closest(".host-neutral")).toBeTruthy();
      expect(screen.getByText("Warning · Sleeps when idle").closest(".host-neutral")).toBeTruthy();
      expect(screen.getByText("Needs Command Line Tools")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install git" })).toBeNull();
    }
  },
);
const failures: HostFailure[] = [
  "unreachable",
  "unsupported",
  "libc-too-old",
  "libc-unsupported",
  "artifact-unavailable",
  "facts-unavailable",
  "folder-missing",
  "folder-refused",
  "unsafe-folder",
  "origin-unavailable",
  "origin-auth",
  "origin-host-key",
  "origin-unreachable",
  "timed-out",
  "checkout-invalid",
  "clone-failed",
  "checkout-refused",
  "version-mismatch",
  "provider-invalid",
  "configuration-changed",
  "invalid-reply",
  "cancelled",
];
test.each(failures)(
  "fixed %s reason is visible beside independent unrun checks",
  async (reason) => {
    const result = { ok: false as const, reason };
    await mount({
      ...initial,
      hosts: [{ ...host, result }],
      preflight: {
        ssh: { state: "pass" },
        platform: { state: "fail", reason },
        artifact: { state: "not-checked" },
        result,
        repositories: [],
      },
    });
    await screen.findByText(new RegExp(` · ${reason}$`, "u"));
    expect(screen.getByText("Pass · Host key trusted")).toBeTruthy();
    expect(screen.getAllByText("Not checked").length).toBeGreaterThan(1);
  },
);
test("legacy and missing facts stay unknown; pending checks and rejected promises use fixed messages", async () => {
  const { api, unmount } = await mount({
    hosts: [
      { host: "unchecked", codeFolder: "/code" },
      {
        ...host,
        result: {
          ...host.result,
          facts: {
            codeFolder: facts.codeFolder,
            version: facts.version,
            sessions: facts.sessions,
            cores: facts.cores,
            load: facts.load,
            memoryTotal: facts.memoryTotal,
            memoryAvailable: facts.memoryAvailable,
            agents: facts.agents,
          },
        },
      },
    ],
    locations: [],
  });
  await screen.findAllByText("git / gh");
  await waitFor(() => {
    expect(
      screen.getAllByRole<HTMLButtonElement>("button", { name: "Check capabilities" })[0]?.disabled,
    ).toBe(false);
  });
  api.mockRejectedValue(new Error("RAW SECRET"));
  fireEvent.click(
    screen.getAllByRole("button", { name: "Check capabilities" })[0] ?? document.body,
  );
  await screen.findByText("Unable to update hosts");
  expect(screen.queryByText("RAW SECRET")).toBeNull();
  unmount();
  const view = await mount();
  await screen.findByText("Pass · Host key trusted");
  let resolve: ((state: HostsState) => void) | undefined;
  view.api.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  expect(screen.getByText("Checking host…")).toBeTruthy();
  view.unmount();
  resolve?.(initial);
});
test("initial load rejection, cancelled add, absent API and unmount during initial preflight", async () => {
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockRejectedValue(new Error("secret"));
  const view = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByText("Unable to load hosts");
  api.mockResolvedValue({
    hosts: [],
    locations: [],
    result: { ok: false, reason: "invalid-reply" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "worker" } });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByText("Invalid host reply");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("SSH host")).toBeNull();
  view.unmount();
  const absent = render(<HostsSettings source={{}} headingRef={createRef()} />);
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "worker" } });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await waitFor(() => {
    expect(screen.queryByText("Checking…")).toBeNull();
  });
  absent.unmount();
  let resolve: ((state: HostsState) => void) | undefined;
  api.mockResolvedValueOnce(initial).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "preflight",
      host: "worker",
      codeFolder: host.codeFolder,
    });
  });
  pending.unmount();
  resolve?.(initial);
});
const repositories = [
  { name: "project", path: "/local/project" },
  { name: "changed", path: "/local/changed" },
  { name: "clean", path: "/local/clean" },
];
function locations(): HostsState {
  return {
    ...initial,
    locations: repositories.map((repo, index) => ({
      host: "worker",
      repository: repo.path,
      result: {
        ...host.result,
        checkout: {
          path: `/remote/${repo.name}`,
          state: index === 0 ? "absent" : index === 1 ? "changed" : "clean",
        },
      },
    })),
  };
}
test("repository locations show only existing checkouts and never offer cloning", async () => {
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(locations());
  render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  const remote = await screen.findByRole("region", { name: "worker" });
  expect(remote.querySelectorAll(".host-repository-row")).toHaveLength(2);
  for (const text of ["Clone here", "Not checked out", "Changes", "Clean"])
    expect(screen.queryByText(text)).toBeNull();
  api.mockRejectedValueOnce(new Error("private"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await screen.findByText("Unable to check locations");
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(api.mock.calls.every(([action]) => action.action === "locations")).toBe(true);
});
test("location load rejection, missing observations and unmount before locations settle", async () => {
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockRejectedValue(new Error("secret"));
  const view = render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  await screen.findByText("Unable to check locations");
  view.unmount();
  api.mockResolvedValue({
    ...initial,
    locations: [{ host: "worker", repository: "/local/project", result: host.result }],
  });
  const unknown = render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  await screen.findByRole("region", { name: "worker" });
  expect(screen.queryByText("Not checked")).toBeNull();
  unknown.unmount();
  let resolve: ((state: HostsState) => void) | undefined;
  api.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  pending.unmount();
  resolve?.(initial);
});
test.each([true, false])(
  "copies send only registered identifiers, capability available %s",
  async (available) => {
    const copyHost = vi.fn(async () => {});
    const source = {
      hosts: () => Promise.resolve(locations()),
      ...(available ? { copyHost } : {}),
    };
    const view = render(<HostsSettings source={source} headingRef={createRef()} />);
    await screen.findByRole("region", { name: "worker" });
    expandHosts();
    fireEvent.click(await screen.findByRole("button", { name: "Copy host alias" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy code folder" }));
    if (available)
      expect(copyHost).toHaveBeenLastCalledWith({ kind: "copy-host-code-folder", host: "worker" });
    else
      await waitFor(() => {
        expect(screen.getAllByText("Unable to copy")).toHaveLength(2);
      });
    view.unmount();
    render(<RepositoryHosts source={source} repositories={repositories} />);
    await screen.findByText("/remote/changed");
    for (const button of screen.getAllByRole("button", { name: "Copy checkout path" }))
      fireEvent.click(button);
    if (available)
      expect(copyHost).toHaveBeenCalledWith({
        kind: "copy-checkout-path",
        host: "worker",
        repository: "/local/changed",
      });
    else
      await waitFor(() => {
        expect(screen.getAllByText("Unable to copy")).toHaveLength(5);
      });
  },
);

test("ready hosts list checkout paths without rendering dirty or clone state", async () => {
  await mount({
    ...initial,
    preflight: {
      ...preflight,
      repositories: [
        {
          repository: "/local/project",
          origin: { state: "pass" },
          checkout: { ...host.result, checkout: { path: "/remote/project", state: "changed" } },
        },
      ],
    },
  });
  await screen.findByText("Ready");
  fireEvent.click(screen.getByText("Git access · 1 ready"));
  expect(screen.getByText("/remote/project")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clone here" })).toBeNull();
});
test("unknown distro offers no install recipe and initial preflight failures stay fixed", async () => {
  const result = {
    ...host.result,
    facts: {
      ...facts,
      requirements: {
        distro: "unknown" as const,
        libc: "supported" as const,
        packageManager: "none" as const,
      },
    },
  };
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockResolvedValueOnce({ ...initial, hosts: [{ ...host, result }] })
    .mockRejectedValueOnce(new Error("secret"));
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await screen.findByText("Unable to update hosts");
});
test("absent checkouts have no clone state or clone control in Hosts", async () => {
  await mount();
  expect(screen.queryByText("Not checked out")).toBeNull();
  expect(screen.queryByRole("button", { name: "Clone here" })).toBeNull();
  expect(
    screen.getByText("Foom checks out repositories automatically when you use this host."),
  ).toBeTruthy();
});

test("Mac protected-folder warning never hides a missing-folder failure or its Create action", async () => {
  const result = {
    ok: true as const,
    facts: {
      ...facts,
      folder: { state: "fail" as const, reason: "folder-missing" as const },
      requirements: {
        distro: "darwin" as const,
        libc: "supported" as const,
        packageManager: "brew" as const,
        mac: { commandLineTools: true, protectedFolder: true, staysAwake: true },
      },
    },
  };
  await mount({ ...initial, hosts: [{ ...host, result }], preflight: { ...preflight, result } });
  await screen.findByText("Code folder does not exist · folder-missing · Protected folder");
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change folder" })).toBeTruthy();
});

test("a failed connection row is not repeated as helper copy, and credential tips only accompany auth failures", async () => {
  const result = { ok: false as const, reason: "artifact-unavailable" as const };
  const view = await mount({
    ...initial,
    hosts: [{ ...host, result }],
    preflight: {
      ...preflight,
      result,
      artifact: { state: "fail", reason: "artifact-unavailable" },
      repositories: [
        {
          repository: "/local/project",
          origin: { state: "fail", reason: "artifact-unavailable" },
          checkout: result,
        },
      ],
    },
  });
  await screen.findAllByText("This build has no remote host support · artifact-unavailable");
  expect(screen.queryByText("This build has no remote host support", { exact: true })).toBeNull();
  expect(screen.queryByLabelText("Git access fixes")).toBeNull();
  view.unmount();
  await mount({
    hosts: [{ ...host, result: { ok: false, reason: "version-mismatch" } }],
    locations: [],
  });
  await screen.findByText("Host version mismatch");
});

test("host aliases and agent IDs are literal data even when they name object prototypes", async () => {
  const result = {
    ok: true as const,
    facts: { ...facts, agents: [{ id: "constructor", state: "unable" as const }] },
  };
  const state: HostsState = { hosts: [{ ...host, host: "constructor", result }], locations: [] };
  let finish: ((next: HostsState) => void) | undefined;
  const pending = new Promise<HostsState>((resolve) => {
    finish = resolve;
  });
  const api = vi.fn((action: HostsAction) =>
    action.action === "preflight" ? pending : Promise.resolve(state),
  );
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "constructor" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  expect(screen.getAllByText("constructor")).toHaveLength(3);
  await act(async () => {
    finish?.({ ...state, preflight: { ...preflight, result } });
    await pending;
  });
  await screen.findByText("Pass · Host key trusted");
  expect(screen.getAllByText("constructor")).toHaveLength(3);
});

test("inline host names validate, save without preflight, cancel and restore the default", async () => {
  let state: HostsState = {
    ...initial,
    hosts: [
      { ...host, host: "me@worker.local" },
      { ...host, host: "other", nickname: "Other box" },
    ],
  };
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockImplementation((action) => {
    if (action.action === "rename")
      state = {
        ...state,
        hosts: state.hosts.map((entry) =>
          entry.host === action.host
            ? action.nickname
              ? { ...entry, nickname: action.nickname }
              : { host: entry.host, codeFolder: entry.codeFolder }
            : entry,
        ),
      };
    return Promise.resolve(state);
  });
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "me@worker.local" });
  expandHosts();
  await screen.findByRole("button", { name: "Rename worker" });
  await waitFor(() => {
    expect(
      screen
        .getAllByRole<HTMLButtonElement>("button", { name: "Check capabilities" })
        .every((button) => !button.disabled),
    ).toBe(true);
  });
  api.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Rename worker" }));
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Host nickname" });
  expect(input.getAttribute("placeholder")).toBe("worker");
  fireEvent.change(input, { target: { value: "other BOX" } });
  expect(screen.getByRole("alert").textContent).toBe("Name already used");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save name" }).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  if (input.form) fireEvent.submit(input.form);
  expect(api).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "Build box" } });
  fireEvent.keyDown(input, { key: "Enter" });
  if (input.form) fireEvent.submit(input.form);
  await screen.findByRole("button", { name: "Rename Build box" });
  expect(api.mock.calls).toEqual([
    [{ action: "rename", host: "me@worker.local", nickname: "Build box" }],
  ]);
  expect(screen.getByText("me@worker.local")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rename Build box" }));
  fireEvent.keyDown(screen.getByLabelText("Host nickname"), { key: "Escape" });
  expect(screen.queryByLabelText("Host nickname")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rename Build box" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename Build box" }));
  api.mockRejectedValueOnce(new Error("disk"));
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByText("Unable to rename host");
  fireEvent.change(screen.getByLabelText("Host nickname"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("button", { name: "Rename worker" });
});

test("progress text follows the observed phase and repository position", () => {
  const progress: HostCheckProgress = {
    host: "worker",
    phase: "inspect",
    repositories: [{ repository: "/local/first" }, { repository: "C:\\code\\foom" }],
  };
  expect(hostProgressText(undefined)).toBe("Checking host…");
  expect(hostProgressText(progress)).toBe("Checking host…");
  expect(hostProgressText({ ...progress, phase: "origin", repository: "C:\\code\\foom" })).toBe(
    "Checking Git access · foom (2 of 2)",
  );
  expect(hostProgressText({ ...progress, phase: "checkout", repository: "/local/first" })).toBe(
    "Checking checkout · first (1 of 2)",
  );
});
test("first check renders pending repository rows and replaces them with observations", async () => {
  let finish: ((state: HostsState) => void) | undefined;
  const pending = new Promise<HostsState>((resolve) => {
    finish = resolve;
  });
  let progress: HostCheckProgress = {
    host: "worker",
    phase: "origin",
    repository: "/local/project",
    result: host.result,
    repositories: [{ repository: "/local/project" }, { repository: "/local/next" }],
  };
  const api = vi.fn((action: HostsAction) =>
    action.action === "preflight"
      ? pending
      : Promise.resolve(action.action === "progress" ? { ...initial, progress } : initial),
  );
  const view = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await screen.findByText("Checking Git access · project (1 of 2)");
  expect(screen.getAllByText("Checking…", { exact: true })).toHaveLength(2);
  expect(screen.getByText("Repository · next")).toBeTruthy();
  expect(view.container.querySelector(".host-throbber")?.getAttribute("aria-hidden")).toBe("true");
  progress = {
    ...progress,
    phase: "checkout",
    repositories: [
      { repository: "/local/project", origin: { state: "pass" } },
      { repository: "/local/next" },
    ],
  };
  await screen.findByText("Checking checkout · project (1 of 2)");
  expect(screen.getByText("Pass · Reachable")).toBeTruthy();
  act(() => {
    finish?.(initial);
  });
  await waitFor(() => {
    expect(view.container.querySelector(".host-throbber")).toBeNull();
  });
  expect(view.container.querySelector(".host-throbber")).toBeNull();
  const calls = api.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(api).toHaveBeenCalledTimes(calls);
});
test("progress polling failures leave the authoritative check running; unmount ignores late reads", async () => {
  let resolveProgress: ((state: HostsState) => void) | undefined;
  const late = new Promise<HostsState>((resolve) => {
    resolveProgress = resolve;
  });
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>();
  api.mockImplementation((action) =>
    action.action === "preflight"
      ? new Promise(() => {})
      : action.action === "progress"
        ? Promise.reject(new Error("unavailable"))
        : Promise.resolve(initial),
  );
  const view = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await screen.findByText("Checking host…");
  api.mockImplementation((action) =>
    action.action === "progress" ? late : Promise.resolve(initial),
  );
  await waitFor(() => {
    expect(
      api.mock.calls.filter(([action]) => action.action === "progress").length,
    ).toBeGreaterThan(1);
  });
  view.unmount();
  act(() => {
    resolveProgress?.({
      ...initial,
      progress: { host: "worker", phase: "inspect", repositories: [] },
    });
  });
});

test("usable hosts keep optional missing agents, sign-in and checkouts neutral", async () => {
  const result = {
    ...host.result,
    facts: {
      ...facts,
      tools: [
        { id: "git", state: "ready" as const, signIn: "unknown" as const },
        { id: "gh", state: "missing" as const, signIn: "unknown" as const },
      ],
      agents: [
        ...facts.agents,
        { id: "opencode", state: "missing" as const },
        { id: "pi", state: "missing" as const },
      ],
    },
  };
  await mount({
    ...initial,
    hosts: [{ ...host, result, recipes: [{ tool: "pi", install: true, signIn: false }] }],
    preflight: { ...preflight, result },
  });
  await screen.findByText("Ready");
  expect(screen.queryByText("Not checked out")).toBeNull();
  expect(screen.getAllByText("Not found").every((item) => item.closest(".host-neutral"))).toBe(
    true,
  );
  expect(screen.getByRole("button", { name: "Install pi" })).toBeTruthy();
});
test("host-key fix identifies only the repository", async () => {
  const state: HostsState = {
    ...initial,
    preflight: {
      ...preflight,
      repositories: [
        {
          repository: "/local/project",
          origin: { state: "fail", reason: "origin-host-key" },
          checkout: {
            ...host.result,
            checkout: {
              path: "/remote/project",
              state: "clean",
            },
          },
        },
      ],
    },
  };
  const { api } = await mount(state);
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Trust host key" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Trust host key" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "trust-origin",
      host: "worker",
      repository: "/local/project",
    });
  });
});
test("opening uses saved checks, keeps ready hosts compact and exposes every ready repository", async () => {
  const state = saved({
    ...initial,
    preflight: {
      ...preflight,
      repositories: Array.from({ length: 6 }, (_, index) => ({
        repository: `/local/project-${String(index)}`,
        origin: { state: "pass" },
        checkout: {
          ...host.result,
          checkout: { path: `/remote/project-${String(index)}`, state: "clean" },
        },
      })),
    },
  });
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(state);
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByText("Ready");
  expect(api.mock.calls).toEqual([[{ action: "list" }]]);
  expect(screen.queryByRole("button", { name: "Check capabilities" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand worker" }));
  expect(screen.getByText(/Last checked/u)).toBeTruthy();
  expect(screen.queryByText("Repository · project-0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Git access · 6 ready/u }));
  expect(screen.getAllByText(/^\/remote\/project-/u)).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: /Git access · 6 ready/u }));
  expect(screen.queryByText("Repository · project-0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Collapse worker" }));
  expect(screen.queryByRole("button", { name: "Check capabilities" })).toBeNull();
});

test("slow list and independent host checks leave Add enabled and preserve a newly added host", async () => {
  let finishList: ((state: HostsState) => void) | undefined;
  let finishCheck: ((state: HostsState) => void) | undefined;
  const state = saved(initial);
  const added = { ...host, host: "second" };
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockImplementation((action) => {
    if (action.action === "list")
      return new Promise((resolve) => {
        finishList = resolve;
      });
    if (action.action === "preflight" && action.host === "worker")
      return new Promise((resolve) => {
        finishCheck = resolve;
      });
    if (action.action === "progress") return Promise.resolve(state);
    return Promise.resolve({ ...state, hosts: [...state.hosts, added] });
  });
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(false);
  await act(async () => {
    finishList?.(state);
    await Promise.resolve();
  });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Rename worker" }).matches(":disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "second" } });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByRole("region", { name: "second" });
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "preflight",
      host: "second",
      codeFolder: host.codeFolder,
    });
  });
  const second = screen.getByRole("region", { name: "second" });
  await waitFor(() => {
    expect(within(second).getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(
      false,
    );
  });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(false);
  await act(async () => {
    finishCheck?.(state);
    await Promise.resolve();
  });
  expect(screen.getByRole("region", { name: "second" })).toBeTruthy();
  expect(api.mock.calls.filter(([action]) => action.action === "preflight")).toHaveLength(2);
});

test("Add becomes available after enrollment while its automatic capability check is still pending", async () => {
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockImplementation((action) =>
      action.action === "preflight"
        ? new Promise(() => {})
        : Promise.resolve(action.action === "list" ? { hosts: [], locations: [] } : initial),
    );
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "worker" } });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByText("Checking host…");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "SSH host" }).matches(":disabled"),
  ).toBe(false);
});

test("a restarted Hosts owner restores Brew Install and Sign in buttons without a remote read", async () => {
  const fixture = await restartedBrewHost();
  try {
    const api = vi.fn((action: HostsAction) => fixture.hosts.action(action));
    render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
    await screen.findByRole("region", { name: "mac-fixture" });
    expandHosts();
    for (const name of ["Install git", "Sign in gh", "Sign in codex"]) {
      expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false);
    }
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.getAllByText("Signed out")).toHaveLength(2);
    expect(api).toHaveBeenCalledExactlyOnceWith({ action: "list" });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(remoteReads.management).not.toHaveBeenCalled();
    expect(remoteReads.inventory).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await fixture.dispose();
  }
});

test("the name and OS appear once in both compact and expanded host headers", async () => {
  const result = {
    ok: true as const,
    facts: {
      ...facts,
      requirements: {
        distro: "darwin" as const,
        libc: "supported" as const,
        packageManager: "brew" as const,
      },
    },
  };
  const state = saved({
    hosts: [{ ...host, nickname: "Build box", result }],
    locations: [],
    preflight: { ...preflight, result },
  });
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(state);
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("button", { name: "Expand Build box" });
  for (const action of ["Expand", "Collapse", "Expand"]) {
    expect(screen.getAllByText("Build box")).toHaveLength(1);
    expect(screen.getAllByText("macOS")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: `${action} Build box` }));
  }
  expect(screen.getByRole("button", { name: "Rename Build box" })).toBeTruthy();
  expect(screen.getAllByText("Build box")).toHaveLength(1);
  expect(screen.getAllByText("macOS")).toHaveLength(1);
});

test("row reload keeps other rows usable and does not run a full preflight", async () => {
  const { api } = await mount();
  let finish: ((state: HostsState) => void) | undefined;
  api.mockImplementation((action) =>
    action.action === "progress"
      ? Promise.resolve(saved(initial))
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const button = screen.getByRole("button", { name: "Reload git" });
  fireEvent.click(button);
  expect(button.closest(".host-check-row")?.textContent).toContain("Checking…");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reload SSH" }).disabled).toBe(
    false,
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change folder" }).disabled).toBe(
    false,
  );
  expect(
    api.mock.calls.map(([action]) => action).filter((action) => action.action !== "progress"),
  ).toContainEqual({
    action: "reload",
    host: "worker",
    target: { kind: "tool", tool: "git" },
  });
  await act(async () => {
    finish?.(saved(initial));
    await Promise.resolve();
  });
  expect(api.mock.calls.some(([action]) => action.action === "preflight")).toBe(false);
  api.mockRejectedValue(new Error("offline"));
  fireEvent.click(button);
  await waitFor(() => {
    expect(button.closest(".host-check-row")?.textContent).toContain("Unable to check");
  });
  expect(screen.queryByText("Unable to reload host row")).toBeNull();
  api.mockResolvedValue(saved(initial));
  fireEvent.click(button);
  await waitFor(() => {
    expect(button.closest(".host-check-row")?.textContent).not.toContain("Unable to check");
  });
});

test("failed resource refresh reports its failure without replacing checklist results", async () => {
  const { api } = await mount();
  api.mockResolvedValue(
    saved({ ...initial, hosts: [{ ...host, result: { ok: false, reason: "unreachable" } }] }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh facts" }));
  await screen.findByText("Host unreachable");
  expect(screen.getByText("Pass · Host key trusted")).toBeTruthy();
  expect(api.mock.calls.some(([action]) => action.action === "preflight")).toBe(false);
});

test("Add nickname validates inline, preserves invalid or failed input and submits valid names", async () => {
  const { api } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "second" } });
  const input = screen.getByLabelText("Nickname (optional)");
  fireEvent.change(input, { target: { value: "worker" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add host" }).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("Name already used");
  fireEvent.change(input, { target: { value: "<invalid>" } });
  expect(screen.getByRole("alert").textContent).toContain("Use 1–40");
  const form = input.closest("form");
  if (!form) throw new Error("Missing add form");
  fireEvent.submit(form);
  expect(api.mock.calls.some(([action]) => action.action === "add")).toBe(false);
  fireEvent.change(input, { target: { value: "Build box" } });
  api.mockRejectedValueOnce(new Error("Failed"));
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByText("Unable to update hosts");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Nickname (optional)" }).value).toBe(
    "Build box",
  );
  expect(api).toHaveBeenCalledWith({
    action: "add",
    host: "second",
    codeFolder: "~/foom",
    nickname: "Build box",
  });
});

test("rename stays editable during checks and a stale check reply preserves the new name", async () => {
  const { api } = await mount();
  let finish: ((state: HostsState) => void) | undefined;
  api.mockImplementation((action) => {
    if (action.action === "preflight")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (action.action === "rename")
      return Promise.resolve({ ...initial, hosts: [{ ...host, nickname: action.nickname }] });
    return Promise.resolve(initial);
  });
  fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
  await waitFor(() => {
    expect(finish).toBeDefined();
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename worker" }));
  fireEvent.change(screen.getByLabelText("Host nickname"), { target: { value: "During check" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("button", { name: "Rename During check" });
  await act(async () => {
    finish?.(initial);
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Rename During check" })).toBeTruthy();
});

test.each(["Build box", ""])(
  "late check replies preserve repeated renames ending with %j",
  async (finalName) => {
    const { api } = await mount();
    let finish: ((state: HostsState) => void) | undefined;
    api.mockImplementation((action) => {
      if (action.action === "preflight")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (action.action === "rename")
        return Promise.resolve({
          ...initial,
          hosts: [action.nickname ? { ...host, nickname: action.nickname } : host],
        });
      return Promise.resolve(initial);
    });
    const rename = async (from: string, to: string) => {
      fireEvent.click(screen.getByRole("button", { name: `Rename ${from}` }));
      fireEvent.change(screen.getByLabelText("Host nickname"), { target: { value: to } });
      fireEvent.click(screen.getByRole("button", { name: "Save name" }));
      await screen.findByRole("button", { name: `Rename ${to || "worker"}` });
    };
    await rename("worker", "Build box");
    fireEvent.click(screen.getByRole("button", { name: "Check capabilities" }));
    await waitFor(() => {
      expect(finish).toBeDefined();
    });
    await rename("Build box", "Interim");
    await rename("Interim", finalName);
    await act(async () => {
      finish?.({ ...initial, hosts: [{ ...host, nickname: "Interim" }] });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: `Rename ${finalName || "worker"}` })).toBeTruthy();
  },
);

test("an unrepresentable row failure names Check capabilities only in that row", async () => {
  const failed: HostPreflight = { ...preflight, result: { ok: false, reason: "unreachable" } };
  const { api } = await mount({
    ...initial,
    preflight: failed,
    hosts: [{ ...host, result: failed.result }],
  });
  api.mockRejectedValue(new Error("Unable to display host row without a full check"));
  const button = screen.getByRole("button", { name: "Reload Code folder" });
  fireEvent.click(button);
  await waitFor(() => {
    expect(button.closest(".host-check-row")?.textContent).toContain("Check capabilities required");
  });
  expect(screen.queryByText("Unable to reload host row")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reload SSH" }).disabled).toBe(
    false,
  );
  expect(screen.getByText(/Last checked/u).textContent).toContain("Last checked");
});

test("a later live folder reply replaces a transient reload checklist", async () => {
  const raw: HostsState = { hosts: [host], locations: [] };
  const missing = {
    ok: true as const,
    facts: {
      ...facts,
      codeFolder: "/home/worker/new",
      folder: { state: "fail" as const, reason: "folder-missing" as const },
    },
  };
  const api = vi.fn(
    (action: HostsAction): Promise<HostsState> =>
      Promise.resolve(
        action.action === "reload"
          ? { ...raw, preflight: { ...preflight, repositories: [] } }
          : action.action === "change-folder"
            ? {
                hosts: [{ ...host, codeFolder: missing.facts.codeFolder, result: missing }],
                locations: [],
                result: missing,
              }
            : raw,
      ),
  );
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  fireEvent.click(screen.getByRole("button", { name: "Reload Code folder" }));
  await screen.findByText("Pass · Valid");
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  fireEvent.change(screen.getByLabelText("Code folder"), {
    target: { value: missing.facts.codeFolder },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Create" });
  expect(screen.getByText("Code folder does not exist · folder-missing")).toBeTruthy();
  expect(screen.queryByText("Pass · Valid")).toBeNull();
  expect(screen.queryByText(/Last checked/u)).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "Hosts remains readable while queued row saves keep failing",
  async () => {
    const fixture = await restartedBrewHost();
    try {
      await fixture.hosts.action(
        { action: "recipe", host: "mac-fixture", tool: "gh", operation: "install" },
        undefined,
        () => Promise.resolve(),
      );
      await chmod(fixture.root, 0o555);
      const api = (action: HostsAction) => fixture.hosts.action(action);
      render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
      const card = await screen.findByRole("region", { name: "mac-fixture" });
      expandHosts();
      expect(within(card).getAllByText("Unable to save")).toHaveLength(2);
      expect(screen.queryByText("Unable to load hosts")).toBeNull();
    } finally {
      await chmod(fixture.root, 0o700);
      await fixture.dispose();
    }
  },
);

test("host check output remains inert, readable and dismissible after failure", async () => {
  const output = {
    host: "worker",
    text: "<script>never execute</script>\nSSH refused",
    running: false,
    failed: true,
  };
  const { api } = await mount({ ...initial, output });
  const panel = await screen.findByRole("region", { name: "Host check output" });
  expect(panel.textContent).toContain(output.text);
  expect(panel.querySelector("script")).toBeNull();
  expect(within(panel).getByRole("status").textContent).toBe("Failed");
  fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("region", { name: "Host check output" })).toBeNull();
  expect(api).toHaveBeenCalledWith({ action: "dismiss-output" });
});

test.each([false, true])(
  "embedded recipe exit reloads its saved rows (read fails: %s)",
  async (fails) => {
    let exit = (_state: { exited: boolean; code?: number }) => {};
    const view: TerminalViewSource = {
      mount: () => () => {},
      open: async () => {},
      hide: async () => {},
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
    };
    const missing: HostsState = {
      ...initial,
      preflight: {
        ...preflight,
        result: {
          ok: true,
          facts: { ...facts, tools: [{ id: "git", state: "missing", signIn: "unknown" }] },
        },
      },
      hosts: [{ ...host, recipes: [{ tool: "git", install: true, signIn: false }] }],
    };
    const { api } = await mount(missing, {
      hostTerminal: {
        createView: () => view,
        observe: (_id, listener) => {
          exit = listener;
          return () => {};
        },
      },
    });
    api.mockResolvedValue({ ...missing, recipeSession: "recipe" });
    fireEvent.click(screen.getByRole("button", { name: "Install git" }));
    await screen.findByRole("region", { name: "Install terminal" });
    const listReads = api.mock.calls.filter(([action]) => action.action === "list").length;
    if (fails)
      api.mockImplementation((action) =>
        action.action === "list"
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(missing),
      );
    await act(async () => {
      exit({ exited: true, code: 0 });
      await Promise.resolve();
    });
    if (fails) expect(screen.getByText("Unable to refresh tool")).toBeTruthy();
    else
      expect(api.mock.calls.filter(([action]) => action.action === "list")).toHaveLength(
        listReads + 1,
      );
  },
);

test("installs on different hosts keep their own terminal panels", async () => {
  const result: HostPreflight["result"] = {
    ok: true,
    facts: { ...facts, tools: [{ id: "git", state: "missing", signIn: "unknown" }] },
  };
  const missing: HostsState = {
    ...initial,
    preflight: { ...preflight, result },
    hosts: [host, { ...host, host: "second" }].map((entry) => ({
      ...entry,
      recipes: [{ tool: "git", install: true, signIn: false }],
    })),
  };
  const { api } = await mount(missing, {
    hostTerminal: {
      createView: () => ({
        mount: () => () => {},
        open: async () => {},
        hide: async () => {},
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
      observe: (_id, listener) => {
        listener({ exited: false });
        return () => {};
      },
    },
  });
  api.mockImplementation((action) =>
    Promise.resolve(
      action.action === "recipe" ? { ...missing, recipeSession: `${action.host}-recipe` } : missing,
    ),
  );
  for (const name of ["worker", "second"]) {
    const card = screen.getByRole("region", { name });
    fireEvent.click(within(card).getByRole("button", { name: "Install git" }));
    await within(card).findByRole("region", { name: "Install terminal" });
  }
  expect(screen.getAllByRole("region", { name: "Install terminal" })).toHaveLength(2);
});

test("returning to Hosts reattaches the window's install without starting another process", async () => {
  const open = vi.fn(() => Promise.resolve());
  const disposed = vi.fn();
  const close = vi.fn(() => Promise.resolve());
  const { api, unmount } = await mount(initial, {
    installs: {
      sessions: () => new Map([["worker", "existing-install"]]),
      hasSessions: () => true,
      running: () => Promise.resolve(true),
      close,
      dispose: () => {},
    },
    hostTerminal: {
      createView: () => ({
        mount: () => disposed,
        open,
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
      observe: (_id, listener) => {
        listener({ exited: false });
        return () => {};
      },
    },
  });
  await screen.findByRole("region", { name: "Install terminal" });
  expect(open).toHaveBeenCalledWith("existing-install");
  expect(api.mock.calls.some(([action]) => action.action === "recipe")).toBe(false);
  unmount();
  expect(disposed).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

test.each([
  [{}, "0 of 0 ready"],
  [{ opencode: true, claude: false }, "0 of 1 ready"],
  [{ claude: true }, "1 of 1 ready"],
  [{ claude: true, opencode: true }, "1 of 2 ready"],
] as const)("host readiness counts only explicitly enabled agents %j", async (agents, text) => {
  const state = saved(initial);
  const hosts = vi.fn(() => Promise.resolve(state));
  const openAgents = vi.fn();
  render(
    <HostsSettings
      source={{ hosts }}
      headingRef={createRef()}
      agents={agents}
      openAgents={openAgents}
    />,
  );
  await screen.findByRole("region", { name: "worker" });
  expandHosts();
  expect(screen.getByText(text)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(openAgents).toHaveBeenCalledExactlyOnceWith("worker");
});
