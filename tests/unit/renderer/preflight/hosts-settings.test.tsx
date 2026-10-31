// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HostsSettings, RepositoryHosts } from "../../../../src/renderer/preflight/hosts-settings";
import type { HostsAction, HostsState } from "../../../../src/shared/registered-hosts.d";
const facts = {
  codeFolder: "/home/worker/code",
  version: "0.1.0",
  sessions: 2,
  cores: 8,
  load: [1, 2, 3],
  memoryTotal: 8 * 1024 ** 3,
  memoryAvailable: 4 * 1024 ** 3,
  agents: [
    { id: "claude", state: "ready" as const },
    { id: "codex", state: "missing" as const },
    { id: "pi", state: "unable" as const },
  ],
};
const host = { host: "worker", codeFolder: facts.codeFolder, result: { ok: true as const, facts } };
afterEach(cleanup);
test("host form requires a check, clears stale results on edits, and shows live numeric facts and fixed agent states", async () => {
  let state: HostsState = { hosts: [], locations: [] };
  const api = vi.fn((action: HostsAction): Promise<HostsState> => {
    if (action.action === "test") return Promise.resolve({ ...state, result: { ok: true, facts } });
    if (action.action === "add")
      state = { hosts: [host], locations: [], result: { ok: true, facts } };
    if (action.action === "remove") state = { hosts: [], locations: [] };
    return Promise.resolve(state);
  });
  render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByText("No hosts");
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "worker" } });
  fireEvent.change(screen.getByLabelText("Code folder"), { target: { value: "~/code" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Connection ready · Code folder checked");
  fireEvent.change(screen.getByLabelText("Code folder"), { target: { value: "~/foom" } });
  await screen.findByText("Not checked");
  fireEvent.click(screen.getByRole("button", { name: "Check folder" }));
  await screen.findByText("Connection ready · Code folder checked");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByRole("region", { name: "worker" });
  expect(screen.getByText("8.0 GiB")).toBeTruthy();
  expect(screen.getByText("4.0 GiB")).toBeTruthy();
  expect(screen.getByText("1.00 · 2.00 · 3.00")).toBeTruthy();
  for (const text of ["Ready", "Not found", "Unable to check", "Live sessions"])
    expect(screen.getByText(text)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => {
    expect(api).toHaveBeenCalledWith({ action: "refresh", host: "worker" });
  });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove" }).disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("No hosts");
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("SSH host")).toBeNull();
});
test("host failures use fixed text, failed adds stay in the form, and action/load errors are visible", async () => {
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockRejectedValueOnce(new Error("raw secret"));
  const { unmount } = render(<HostsSettings source={{ hosts: api }} headingRef={createRef()} />);
  await screen.findByText("Unable to load hosts");
  api.mockResolvedValue({
    hosts: [],
    locations: [],
    result: { ok: false, reason: "unsafe-folder" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add host" }));
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Code folder ownership or permissions are unsafe");
  api.mockRejectedValueOnce(new Error("raw secret"));
  fireEvent.click(screen.getByRole("button", { name: "Check folder" }));
  await screen.findByText("Unable to update hosts");
  expect(screen.queryByText("raw secret")).toBeNull();
  unmount();
  render(
    <HostsSettings
      source={{
        hosts: () =>
          Promise.resolve({
            hosts: [
              { ...host, result: { ok: false, reason: "unreachable" } },
              { host: "unchecked", codeFolder: "/code" },
            ],
            locations: [],
          }),
      }}
      headingRef={createRef()}
    />,
  );
  await screen.findByText("Host unreachable");
  await screen.findByText("Not checked");
});
test("repositories show Local and host paths, states, Clone here and fixed clone failures", async () => {
  const repositories = [
    { name: "project", path: "/local/project" },
    { name: "changed", path: "/local/changed" },
    { name: "clean", path: "/local/clean" },
  ];
  let state: HostsState = {
    hosts: [host],
    locations: repositories.map((repo, index) => ({
      repository: repo.path,
      host: "worker",
      result: {
        ok: true,
        facts,
        checkout: {
          path: `${facts.codeFolder}/${repo.name}`,
          state: index === 0 ? "absent" : index === 1 ? "changed" : "clean",
        },
      },
    })),
  };
  const api = vi.fn((action: HostsAction): Promise<HostsState> => {
    if (action.action === "clone")
      state = {
        ...state,
        locations: state.locations.map((entry) =>
          entry.repository === action.repository
            ? { ...entry, result: { ok: false, reason: "clone-failed" } }
            : entry,
        ),
      };
    return Promise.resolve(state);
  });
  render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  await screen.findByRole("columnheader", { name: "worker" });
  expect(screen.getByRole("columnheader", { name: "Local" })).toBeTruthy();
  expect(screen.getByText("/local/project")).toBeTruthy();
  expect(screen.getByText("Changes")).toBeTruthy();
  expect(screen.getByText("Clean")).toBeTruthy();
  expect(screen.getByText("Not checked out")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clone here" }));
  await screen.findByText("Could not clone from origin");
  expect(api).toHaveBeenCalledWith({
    action: "clone",
    host: "worker",
    repository: "/local/project",
  });
  api.mockRejectedValueOnce(new Error("raw secret"));
  fireEvent.click(screen.getByRole("button", { name: "Clone here" }));
  await screen.findByText("Unable to clone repository");
  expect(within(screen.getByRole("table")).getAllByText("Checked out")).toHaveLength(3);
});
test("location loading fails with fixed text and disposes pending subscriptions safely", async () => {
  const { unmount } = render(
    <RepositoryHosts
      source={{
        hosts: () => Promise.reject(new Error("raw")),
      }}
      repositories={[]}
    />,
  );
  await screen.findByText("Unable to check locations");
  unmount();
  let resolve: ((state: HostsState) => void) | undefined;
  const pending = new Promise<HostsState>((done) => {
    resolve = done;
  });
  const view = render(<HostsSettings source={{ hosts: () => pending }} headingRef={createRef()} />);
  view.unmount();
  resolve?.({ hosts: [], locations: [] });
});

test("interrupted clones reconcile locations and Refresh locations can recover a lost successful reply", async () => {
  const repositories = [{ name: "project", path: "/local/project" }];
  const location = {
    repository: "/local/project",
    host: "worker",
    result: {
      ok: true as const,
      facts,
      checkout: { path: "/remote/project", state: "absent" as const },
    },
  };
  const initial: HostsState = { hosts: [host], locations: [location] };
  const recovered: HostsState = {
    ...initial,
    locations: [
      {
        ...location,
        result: { ...location.result, checkout: { path: "/remote/project", state: "clean" } },
      },
    ],
  };
  const api = vi
    .fn<(action: HostsAction) => Promise<HostsState>>()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      locations: [{ ...location, result: { ok: false, reason: "unreachable" } }],
    })
    .mockResolvedValueOnce(recovered);
  render(<RepositoryHosts source={{ hosts: api }} repositories={repositories} />);
  fireEvent.click(await screen.findByRole("button", { name: "Clone here" }));
  await screen.findByText("Clean");
  expect(api.mock.calls.map(([action]) => action.action)).toEqual([
    "locations",
    "clone",
    "locations",
  ]);
  api.mockRejectedValueOnce(new Error("private error"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await screen.findByText("Unable to check locations");
  api.mockResolvedValueOnce(recovered);
  fireEvent.click(screen.getByRole("button", { name: "Refresh locations" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

test("registered values have named copy controls that send only host and repository identifiers", async () => {
  const copyHost = vi.fn(async () => {});
  const hosts = () =>
    Promise.resolve({
      hosts: [host],
      locations: [
        {
          host: "worker",
          repository: "/local",
          result: {
            ok: true as const,
            facts,
            checkout: { path: "/remote/repo", state: "clean" as const },
          },
        },
      ],
    });
  const view = render(<HostsSettings source={{ hosts, copyHost }} headingRef={createRef()} />);
  await screen.findByRole("button", { name: "Copy host alias" });
  fireEvent.click(screen.getByRole("button", { name: "Copy host alias" }));
  expect(copyHost).toHaveBeenLastCalledWith({ kind: "copy-host-alias", host: "worker" });
  fireEvent.click(screen.getByRole("button", { name: "Copy code folder" }));
  expect(copyHost).toHaveBeenLastCalledWith({ kind: "copy-host-code-folder", host: "worker" });
  view.unmount();
  render(
    <RepositoryHosts
      source={{ hosts, copyHost }}
      repositories={[{ name: "Repo", path: "/local" }]}
    />,
  );
  await screen.findByText("/remote/repo");
  const buttons = screen.getAllByRole("button", { name: "Copy checkout path" });
  fireEvent.click(buttons[0] ?? document.body);
  expect(copyHost).toHaveBeenLastCalledWith({
    kind: "copy-checkout-path",
    host: null,
    repository: "/local",
  });
  fireEvent.click(buttons[1] ?? document.body);
  expect(copyHost).toHaveBeenLastCalledWith({
    kind: "copy-checkout-path",
    host: "worker",
    repository: "/local",
  });
  await waitFor(() => {
    expect(buttons[1]?.getAttribute("data-copied")).toBe("true");
  });
});

test("unavailable copy capabilities show the fixed failure beside each value", async () => {
  const hosts = () =>
    Promise.resolve({
      hosts: [host],
      locations: [
        {
          host: "worker",
          repository: "/local",
          result: {
            ok: true as const,
            facts,
            checkout: { path: "/remote/repo", state: "clean" as const },
          },
        },
      ],
    });
  const view = render(<HostsSettings source={{ hosts }} headingRef={createRef()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy host alias" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy code folder" }));
  await waitFor(() => {
    expect(screen.getAllByText("Unable to copy")).toHaveLength(2);
  });
  view.unmount();
  render(<RepositoryHosts source={{ hosts }} repositories={[{ name: "Repo", path: "/local" }]} />);
  await screen.findByText("/remote/repo");
  for (const button of screen.getAllByRole("button", { name: "Copy checkout path" }))
    fireEvent.click(button);
  await waitFor(() => {
    expect(screen.getAllByText("Unable to copy")).toHaveLength(2);
  });
});
