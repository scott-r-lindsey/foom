// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SidebarMachineRow } from "../../../../src/renderer/board/sidebar-machine-row";

afterEach(cleanup);

test("machine menu uses host facts and launches human sessions with only a host and agent identifier", async () => {
  const command = vi.fn().mockResolvedValue(undefined);
  const machine = {
    host: "user@dozer.local",
    name: "dozer",
    available: true,
    agents: [{ id: "codex", name: "Codex" }],
  };
  const view = render(
    <SidebarMachineRow machine={machine} compact={false} command={command}>
      <span>Loose session</span>
    </SidebarMachineRow>,
  );
  fireEvent.click(view.getByRole("button", { name: "Actions for dozer" }));
  expect(view.getByRole("menuitem", { name: "New shell" })).toBeTruthy();
  expect(view.queryByRole("menuitem", { name: "New Claude Code" })).toBeNull();
  fireEvent.click(view.getByRole("menuitem", { name: "New Codex" }));
  await waitFor(() => {
    expect(command).toHaveBeenCalledWith({
      kind: "machine-launch",
      host: machine.host,
      run: "codex",
    });
  });
  await waitFor(() => {
    expect(view.queryByRole("menu")).toBeNull();
  });
  fireEvent.click(view.getByRole("button", { name: "dozer" }));
  fireEvent.click(view.getByRole("menuitem", { name: "New shell" }));
  await waitFor(() => {
    expect(command).toHaveBeenLastCalledWith({
      kind: "machine-launch",
      host: machine.host,
      run: "shell",
    });
  });
  await waitFor(() => {
    expect(view.queryByRole("menu")).toBeNull();
  });
  fireEvent.click(view.getByRole("button", { name: "dozer" }));
  fireEvent.click(view.getByRole("button", { name: "dozer" }));
  expect(view.queryByRole("menu")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Actions for dozer" }));
  fireEvent.click(view.getByRole("button", { name: "Actions for dozer" }));
  expect(view.queryByRole("menu")).toBeNull();
  view.rerender(
    <SidebarMachineRow machine={{ ...machine, available: false }} compact={false} command={command}>
      <span>Loose session</span>
    </SidebarMachineRow>,
  );
  expect(view.getByText("⊘ Unavailable")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "dozer · Unavailable" }));
  expect(view.queryByRole("menu")).toBeNull();
  expect(view.getByRole("button", { name: "Actions for dozer" }).hasAttribute("disabled")).toBe(
    true,
  );
  view.rerender(
    <SidebarMachineRow machine={machine} compact command={command}>
      <span>Loose session</span>
    </SidebarMachineRow>,
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByText("Loose session")).toBeTruthy();
});

test("host chips name the host and report unavailability with a symbol and words", async () => {
  const { HostChip } = await import("../../../../src/renderer/board/sidebar-machine-row");
  const view = render(<HostChip machine={{ name: "dozer", available: true }} />);
  expect(view.getByLabelText("Host: dozer").textContent).toBe("dozer");
  expect(view.container.querySelector("svg")).toBeNull();
  view.rerender(<HostChip machine={{ name: "dozer", available: true }} icon />);
  expect(view.container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  view.rerender(<HostChip machine={{ name: "dozer", available: false }} icon />);
  expect(view.getByLabelText("dozer · Unavailable").textContent).toBe("⊘ Unavailable");
});

test("repository placement requires a checked-out remote location and preserves machine order", async () => {
  const { repositoryMachines } = await import("../../../../src/renderer/board/sidebar-model");
  const machines = [
    { host: null, name: "localhost", available: true, agents: [] },
    { host: "second", name: "second", available: false, agents: [], repositories: ["/repo"] },
    { host: "first", name: "first", available: true, agents: [], repositories: ["/repo"] },
    { host: "other", name: "other", available: true, agents: [] },
  ];
  expect(repositoryMachines([], "/repo")).toEqual([]);
  expect(repositoryMachines(machines, "/absent")).toEqual([]);
  expect(repositoryMachines(machines, "/repo").map((machine) => machine.host)).toEqual([
    null,
    "second",
    "first",
  ]);
});

test("repository machine choice stays beside the branch field and sends only the selected host", async () => {
  const { act } = await import("@testing-library/react");
  const { Board } = await import("../../../../src/renderer/board/board-view");
  const { setup } = await import("./sidebar-view-fixtures");
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  const view = setup();
  const repositories = view.source.getSidebar?.() ?? [];
  view.source.getSidebar = () =>
    repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.map((tree) =>
        tree.path === "/tree" ? { ...tree, host: "worker" } : tree,
      ),
    }));
  view.source.getMachines = () => [
    { host: null, name: "localhost", available: true, agents: [] },
    {
      host: "worker",
      name: "worker",
      available: true,
      agents: [{ id: "claude", name: "Claude Code" }],
      repositories: ["/foom"],
    },
  ];
  view.rerender(<Board source={view.source} />);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  fireEvent.click(view.getByRole("menuitem", { name: "New worktree" }));
  fireEvent.click(view.getByRole("menuitem", { name: "worker" }));
  const field = view.getByLabelText("Branch for the new worktree");
  expect(view.queryByRole("menu", { name: "New worktree" })).toBeNull();
  expect(view.getByRole("menuitem", { name: "New worktree" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(view.getAllByLabelText("Host: worker")).toHaveLength(2);
  fireEvent.change(field, { target: { value: "remote/new" } });
  await waitFor(() => {
    expect(view.getByText(/new, from origin default branch/)).toBeTruthy();
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter" });
    await Promise.resolve();
  });
  expect(view.create).toHaveBeenCalledWith("/foom", "remote/new", "worker");
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  fireEvent.click(view.getByRole("menuitem", { name: "New agent" }));
  expect(view.getByRole("menuitem", { name: "localhost" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("menuitem", { name: "worker" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Claude Code" }));
  await waitFor(() => {
    expect(view.command).toHaveBeenCalledWith({
      kind: "repository-launch",
      repository: "/foom",
      host: "worker",
      run: "claude",
    });
  });
  await waitFor(() => {
    expect(view.queryByRole("dialog")).toBeNull();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Claude Code" }));
  await waitFor(() => {
    expect(view.command).toHaveBeenCalledWith({
      kind: "launch",
      repository: "/foom",
      worktree: "/tree",
      run: "claude",
    });
  });
});

test("loose sessions belong to their machine while forgotten hosts remain reachable in the sidebar", async () => {
  const { act } = await import("@testing-library/react");
  const { Board } = await import("../../../../src/renderer/board/board-view");
  const { setup } = await import("./sidebar-view-fixtures");
  localStorage.clear();
  const view = setup();
  const original = view.source.getSnapshot()[0];
  if (!original) throw new Error("fixture row missing");
  const rows: (typeof original)[] = [
    {
      ...original,
      id: "local-machine",
      home: true,
      machine: true,
      placement: { kind: "local" },
      reason: "Local loose",
    },
    {
      ...original,
      id: "remote-machine",
      home: true,
      machine: true,
      placement: { kind: "remote", host: "worker" },
      reason: "Remote loose",
    },
    {
      ...original,
      id: "forgotten-machine",
      home: true,
      machine: true,
      placement: { kind: "remote", host: "forgotten" },
      reason: "Forgotten loose",
    },
  ];
  view.source.getSnapshot = () => rows;
  view.source.getMachines = () => [
    { host: null, name: "localhost", available: true, agents: [] },
    { host: "worker", name: "worker", available: true, agents: [] },
  ];
  view.rerender(<Board source={view.source} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".machine-section .board-row")).toHaveLength(2);
  expect(view.container.querySelector('[data-drag-session="forgotten-machine"]')).toBeTruthy();
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Remote loose" },
  });
  expect(view.container.querySelectorAll(".machine-section .board-row")).toHaveLength(1);
  expect(view.container.querySelector('[data-drag-session="remote-machine"]')).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  expect(view.container.querySelectorAll(".machine-section .board-row")).toHaveLength(2);
});
