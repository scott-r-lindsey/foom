// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RepositorySetupPanel } from "../../../../src/renderer/preflight/repository-setup";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type { SetupReview, SetupRow } from "../../../../src/shared/repository-setup.d";
import { parseSetupList } from "../../../../src/shared/repository-setup";
import { setupPlan } from "../../../../src/shared/repository-setup-catalog";
import type { TerminalViewSource } from "../../../../src/renderer/terminal/terminal-view-source.d";
const list = parseSetupList(
  JSON.stringify({
    requirements: [
      {
        kind: "package",
        id: "native",
        purpose: "Compile native modules",
        sources: [],
        packages: { debian: ["gcc"], rhel: [], arch: ["base-devel"], darwin: "unsupported" },
      },
      {
        kind: "toolchain",
        id: "node",
        tool: "node",
        version: "24.x",
        purpose: "Build tooling",
        sources: ["package.json"],
      },
    ],
    evidence: [],
  }),
);
const plan = setupPlan(list, {
  platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
  items: [
    { id: "native", state: "missing" },
    { id: "node", state: "missing" },
  ],
});
if (!plan) throw new Error("Fixture recipe missing");
const row: SetupRow = {
  repository: "/repo/fixture",
  host: null,
  state: "needs-setup",
  revision: 1,
  missing: ["node"],
  changed: [],
  sourcesAtLaunch: false,
  checkedAt: 100,
  plan,
  token: "a".repeat(32),
};
const review: SetupReview = {
  token: "b".repeat(32),
  repository: row.repository,
  revision: 1,
  list,
  catalog: "c".repeat(64),
  sources: {
    fingerprint: "d".repeat(64),
    files: [{ path: "package.json", digest: "e".repeat(64) }],
  },
  changed: ["package.json"],
};
function fixture(initial: SetupRow = row) {
  const api = vi.fn<NonNullable<SetupSource["repositorySetup"]>>((action) => {
    if (action.action === "review")
      return Promise.resolve({
        rows: [initial],
        review: {
          ...review,
          ...(action.draft ? { list: parseSetupList(action.draft) } : { previous: list }),
        },
      });
    if (action.action === "run")
      return Promise.resolve({
        rows: [{ ...initial, running: "Setup already running" }],
        recipeSession: "fixture-1",
      });
    return Promise.resolve({ rows: [initial] });
  });
  return { api, source: { repositorySetup: api } };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("reads saved observations and edits/imports a data-only list without starting setup", async () => {
  const f = fixture({ ...row, revision: 0, state: "no-list", token: undefined });
  const draftAgent = vi.fn(() => Promise.reject(new Error("No default")));
  render(
    <RepositorySetupPanel source={{ ...f.source, draftSetupAgent: draftAgent }} host={null} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create list" }));
  expect(f.api.mock.calls.map(([action]) => action.action)).toEqual(["list"]);
  fireEvent.click(screen.getByText("Draft with an agent"));
  fireEvent.click(screen.getByRole("button", { name: "Copy draft brief" }));
  await waitFor(() => {
    expect(f.api.mock.calls.some(([action]) => action.action === "copy-brief")).toBe(true);
  });
  fireEvent.click(screen.getByRole("button", { name: "Open repository agent…" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Add OS packages" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
  fireEvent.click(screen.getByRole("button", { name: "Add pnpm" }));
  const input = screen.getByRole("textbox", { name: "Setup draft JSON" });
  expect(input).toHaveProperty("value", expect.stringContaining("24.x"));
  fireEvent.change(input, { target: { value: "{" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
  expect(screen.getByRole("alert").textContent).toContain("valid structured JSON");
  fireEvent.change(input, { target: { value: JSON.stringify(list) } });
  fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
  await screen.findByRole("button", { name: "Approve list" });
  expect(screen.getByText("Compile native modules")).toBeTruthy();
  expect(screen.getAllByText(/exact artifact and integrity/u)).toHaveLength(1);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "darwin" } });
  expect(screen.getByText(/Manual setup required; no catalog recipe/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve list" }));
  await screen.findByRole("button", { name: "Create list" });
  expect(f.api.mock.calls.some(([action]) => action.action === "run")).toBe(false);
});
it("keeps all mappings visible, supports Keep list and cancellation, and removes only through the closed action", async () => {
  const f = fixture();
  render(<RepositorySetupPanel source={f.source} host={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review list" }));
  await screen.findByRole("button", { name: "Keep list" });
  expect(screen.getByText("Unsupported")).toBeTruthy();
  expect(screen.getByText("No packages")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  expect(screen.getByRole("textbox", { name: "Setup draft JSON" })).toHaveProperty(
    "value",
    expect.stringContaining("Build tooling"),
  );
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Remove setup list" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove setup list" }));
  await screen.findByRole("button", { name: "Review list" });
  expect(f.api.mock.calls.some(([action]) => action.action === "remove")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review list" }));
  await screen.findByRole("button", { name: "Cancel" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Keep list" })).toBeNull();
});
it("retains a failed terminal separately from requirements and scopes its exit recheck", async () => {
  const f = fixture();
  const snapshot = {
    status: "Terminal",
    state: "quiet_ok" as const,
    visible: true,
    attaching: false,
    toggleDisabled: false,
    restartDisabled: true,
    toggleLabel: "",
  };
  const view: TerminalViewSource = {
    mount: () => () => {},
    open: vi.fn(() => Promise.resolve()),
    hide: vi.fn(() => Promise.resolve()),
    focus: () => {},
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  };
  let exited: (value: { exited: boolean; code?: number }) => void = () => {};
  const source = {
    ...f.source,
    hostTerminal: {
      createView: () => view,
      observe: (_id: string, listener: typeof exited) => {
        exited = listener;
        queueMicrotask(() => {
          listener({ exited: false });
        });
        return () => {};
      },
    },
  };
  render(<RepositorySetupPanel source={source} host={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
  await screen.findByRole("region", { name: "Install terminal" });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    exited({ exited: true, code: 7 });
  });
  await screen.findByText("Failed · exit code 7");
  await waitFor(() => {
    expect(
      f.api.mock.calls.some(
        ([action]) =>
          action.action === "check" && action.repository === row.repository && action.host === null,
      ),
    ).toBe(true);
  });
  expect(screen.getByText(/Needs setup/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
});
it("shows manual, stale, met and save failures without inferring readiness or offering setup", async () => {
  const f = fixture();
  const rows: SetupRow[] = [
    { ...row, repository: "/repo/manual", state: "manual", token: undefined },
    {
      ...row,
      repository: "/repo/stale",
      state: "review-needed",
      changed: ["package.json"],
      token: undefined,
    },
    {
      ...row,
      repository: "/repo/met",
      state: "met",
      missing: [],
      noRequirements: true,
      token: undefined,
    },
    {
      ...row,
      repository: "/repo/unknown",
      state: "unable",
      sourcesAtLaunch: true,
      failure: "save-failed",
      token: undefined,
    },
  ];
  f.api.mockResolvedValue({ rows });
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  render(<RepositorySetupPanel source={f.source} host={null} targetRepository="/repo/stale" />);
  await screen.findByText(/Manual setup required/u);
  expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  expect(screen.getByText(/does not guarantee/u)).toBeTruthy();
  expect(screen.getByText(/Sources checked at first launch/u)).toBeTruthy();
  await waitFor(() => {
    expect(scroll).toHaveBeenCalled();
  });
});
it("retains the old row on failed checks and stays inert without the capability", async () => {
  const f = fixture({ ...row, token: undefined, state: "not-checked" });
  const rendered = render(<RepositorySetupPanel source={f.source} host={null} />);
  const reload = await screen.findByRole("button", {
    name: "Recheck fixture setup on This computer",
  });
  f.api.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(reload);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  rendered.unmount();
  render(<RepositorySetupPanel source={{}} host={null} />);
  expect(screen.queryByRole("region", { name: "Repository setup" })).toBeNull();
});

it("keeps unsupported suggestions visible and requires their explicit removal before approval", async () => {
  const f = fixture();
  render(<RepositorySetupPanel source={f.source} host={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review list" }));
  await screen.findByRole("button", { name: "Keep list" });
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  f.api.mockResolvedValueOnce({
    rows: [row],
    review: {
      ...review,
      unresolved: [
        {
          kind: "toolchain",
          id: "ruby",
          tool: "ruby",
          version: "3.x",
          purpose: "Application runtime",
          sources: [],
        },
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
  await screen.findByText(/Unresolved · ruby/u);
  expect(screen.getByRole("button", { name: "Approve list" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove requirement ruby" }));
  await screen.findByRole("textbox", { name: "Setup draft JSON" });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "← Back to This computer" }));
  await screen.findByRole("button", { name: "Review list" });
});

it("reports an unavailable saved-state read without running checks", async () => {
  const f = fixture();
  f.api.mockRejectedValueOnce(new Error("offline"));
  render(<RepositorySetupPanel source={f.source} host={null} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Unable to read setup lists");
  expect(f.api).toHaveBeenCalledTimes(1);
});
