// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HostsSettings, RepositoryHosts } from "../../../../src/renderer/preflight/hosts-settings";
import type {
  HostFailure,
  HostPreflight,
  HostsAction,
  HostsState,
} from "../../../../src/shared/registered-hosts.d";
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
function mount(state: HostsState = initial) {
  const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(state);
  const view = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
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
  const { api } = mount();
  await screen.findByText("Pass · Host key trusted");
  for (const text of [
    "Pass · Supported",
    "Pass · In this build",
    "Pass · Valid",
    "Claude Code",
    "Pass · Reachable",
    "Not checked out",
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
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check again" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
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
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clone here" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Clone here" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({
      action: "clone",
      host: "worker",
      repository: "/local/project",
    });
  });
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
  const { api } = mount({
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
    mount({ ...initial, hosts: [{ ...host, result }], preflight: { ...preflight, result } });
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
    mount({
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
  const { api, unmount } = mount({
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
      screen.getAllByRole<HTMLButtonElement>("button", { name: "Check again" })[0]?.disabled,
    ).toBe(false);
  });
  api.mockRejectedValue(new Error("RAW SECRET"));
  fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0] ?? document.body);
  await screen.findByText("Unable to update hosts");
  expect(screen.queryByText("RAW SECRET")).toBeNull();
  unmount();
  const view = mount();
  await screen.findByText("Pass · Host key trusted");
  let resolve: ((state: HostsState) => void) | undefined;
  view.api.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(screen.getAllByText("Checking…")).toHaveLength(2);
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
test("repository locations are per-host lists with paths, states, clones and recovery after lost reply", async () => {
  const state = locations();
  const recovered = {
    ...state,
    locations: state.locations.map((entry) => ({
      ...entry,
      result: { ...host.result, checkout: { path: "/remote/project", state: "clean" as const } },
    })),
  };
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce({
      ...state,
      locations: [
        {
          host: "worker",
          repository: "/local/project",
          result: { ok: false, reason: "unreachable" },
        },
      ],
    })
    .mockResolvedValue(recovered);
  render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  const remote = await screen.findByRole("region", { name: "worker" });
  expect(screen.getByRole("region", { name: "Local" })).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  for (const text of ["Not checked out", "Changes", "Clean"])
    expect(within(remote).getByText(text)).toBeTruthy();
  fireEvent.click(within(remote).getByRole("button", { name: "Clone here" }));
  await waitFor(() => {
    expect(within(remote).getAllByText("Clean")).toHaveLength(3);
  });
  expect(api.mock.calls.map(([action]) => action.action)).toEqual([
    "locations",
    "clone",
    "locations",
  ]);
  api.mockRejectedValueOnce(new Error("private"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await screen.findByText("Unable to check locations");
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
test.each(failures)(
  "repository %s reports a fixed reason; only retryable failures offer Clone here",
  async (reason) => {
    const state = {
      ...initial,
      locations: [
        { host: "worker", repository: "/local/project", result: { ok: false as const, reason } },
      ],
    };
    const api = vi.fn<(action: HostsAction) => Promise<HostsState>>().mockResolvedValue(state);
    render(
      <RepositoryHosts
        source={{ hosts: api }}
        repositories={[{ name: "project", path: "/local/project" }]}
      />,
    );
    await screen.findByText(new RegExp(` · ${reason}$`, "u"));
    const button = screen.queryByRole("button", { name: "Clone here" });
    if (button) {
      api.mockRejectedValueOnce(new Error("raw"));
      fireEvent.click(button);
      await screen.findByText("Unable to clone repository");
    }
  },
);
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
  expect(screen.getAllByText("Not checked")).toHaveLength(3);
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
    await screen.findByText("/remote/project");
    for (const button of screen.getAllByRole("button", { name: "Copy checkout path" }))
      fireEvent.click(button);
    if (available)
      expect(copyHost).toHaveBeenCalledWith({
        kind: "copy-checkout-path",
        host: "worker",
        repository: "/local/project",
      });
    else
      await waitFor(() => {
        expect(screen.getAllByText("Unable to copy")).toHaveLength(6);
      });
  },
);

test("complete means every check and checkout passed; changed checkouts remain usable", async () => {
  mount({
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
  await screen.findByText("Ready · 1 repository");
  expect(screen.getByText("Changes")).toBeTruthy();
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
  await screen.findByText("Unable to load hosts");
  expect(screen.getByText("No install recipe")).toBeTruthy();
});
test("failed clone remains visible after independent preflight, until explicit recheck", async () => {
  const { api } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Clone here" }));
  // Wait for initial observation before sending the mutation.
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clone here" }).disabled).toBe(
      false,
    );
  });
  api
    .mockResolvedValueOnce({
      ...initial,
      locations: [
        {
          host: "worker",
          repository: "/local/project",
          result: { ok: false, reason: "origin-auth" },
        },
      ],
    })
    .mockResolvedValue(initial);
  fireEvent.click(screen.getByRole("button", { name: "Clone here" }));
  await screen.findByText("Origin authentication failed · origin-auth");
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check again" }).disabled).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByText("Not checked out");
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
  mount({ ...initial, hosts: [{ ...host, result }], preflight: { ...preflight, result } });
  await screen.findByText("Code folder does not exist · folder-missing · Protected folder");
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change folder" })).toBeTruthy();
});

test("a failed connection row is not repeated as helper copy, and credential tips only accompany auth failures", async () => {
  const result = { ok: false as const, reason: "artifact-unavailable" as const };
  const view = mount({
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
  mount({ hosts: [{ ...host, result: { ok: false, reason: "version-mismatch" } }], locations: [] });
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
  expect(screen.getAllByText("constructor")).toHaveLength(2);
  await act(async () => {
    finish?.({ ...state, preflight: { ...preflight, result } });
    await pending;
  });
  await screen.findByText("Pass · Host key trusted");
  expect(screen.getAllByText("constructor")).toHaveLength(2);
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
  mount({
    ...initial,
    hosts: [{ ...host, result, recipes: [{ tool: "pi", install: true, signIn: false }] }],
    preflight: { ...preflight, result },
  });
  await screen.findByText("Ready · 0 repositories");
  expect(screen.getByText("Not checked out").closest(".host-status")?.className).toContain(
    "host-neutral",
  );
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
  const { api } = mount(state);
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
test.each(["hosts", "repositories"])(
  "%s clone row stays busy until its result arrives",
  async (surface) => {
    const api = vi
      .fn<(action: HostsAction) => Promise<HostsState>>()
      .mockResolvedValue(surface === "hosts" ? initial : locations());
    render(
      surface === "hosts" ? (
        <HostsSettings source={{ hosts: api }} headingRef={createRef()} />
      ) : (
        <RepositoryHosts source={{ hosts: api }} repositories={repositories} />
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clone here" }).disabled).toBe(
        false,
      );
    });
    let finish: ((state: HostsState) => void) | undefined;
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clone here" }));
    expect(screen.getByText("Cloning…").closest(".host-status")?.className).toContain("host-work");
    await act(async () => {
      finish?.(surface === "hosts" ? initial : locations());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText("Cloning…")).toBeNull();
    });
  },
);
