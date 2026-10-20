// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { emptyPreferences } from "../../../../src/renderer/board/sidebar-preferences";
import { Sidebar, launcherActions } from "../../../../src/renderer/board/sidebar-view";
import type { SidebarPreferences } from "../../../../src/renderer/board/sidebar.d";
import { boardRows as sampleRows } from "../../../fixtures/board";
import { installation } from "../../../fixtures/setup";
import { emptySections, repository, setup } from "./sidebar-view-fixtures";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);

test.each(["empty", "home", "config"] as const)(
  "unmatched filters show one tree-wide message with %s sessions",
  async (location) => {
    const row = sampleRows(0)[0];
    if (!row) throw Error("fixture");
    const view = await emptySections(
      location === "empty"
        ? []
        : [
            {
              ...row,
              home: location === "home",
              config: location === "config",
              reason: "Unique session reason",
            },
          ],
    );
    const input = view.getByLabelText("Filter repositories and sessions");
    fireEvent.change(input, { target: { value: "no-such-session" } });
    expect(view.getAllByText("No matches")).toHaveLength(1);
    expect(view.queryByText("Nothing here yet")).toBeNull();
    expect(view.container.querySelector(".board-list .board-row")).toBeNull();
    if (location === "home") {
      fireEvent.change(input, { target: { value: "Unique session reason" } });
      expect(view.queryByText("No matches")).toBeNull();
      expect(view.queryByText("Nothing here yet")).toBeNull();
      expect(view.container.querySelectorAll(".board-row")).toHaveLength(1);
    }
    fireEvent.click(view.getByRole("button", { name: "Clear filter" }));
    expect(view.queryByText("No matches")).toBeNull();
    if (location !== "home")
      expect(view.getAllByText("Nothing here yet").length).toBeGreaterThan(0);
  },
);

test("worktree deletion remains disabled when filtering hides its running session", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw new Error("Missing fixture");
  const row = {
    ...original,
    repository: "Foom",
    repositoryPath: "/foom",
    worktree: "/tree",
    branch: "feature",
  };
  const base = createSampleSource([
    { ...row, id: "exited", exited: true, reason: "Visible session" },
    {
      ...row,
      id: "running",
      exited: false,
      kind: "shell",
      agent: "shell",
      reason: "Hidden session",
    },
  ]);
  const source: BoardSource = { ...base, getSidebar: () => [repository] };
  const view = render(<Board source={source} />);
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Visible session" },
  });
  expect(view.container.querySelectorAll(".board-row")).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
  const item = () => view.getByRole("menuitem", { name: "Delete worktree…" });
  expect(item().hasAttribute("disabled")).toBe(true);
  await act(async () => {
    base.update("running", { exited: true });
    await Promise.resolve();
  });
  expect(item().hasAttribute("disabled")).toBe(false);
});

test.each(["agent", "shell"] as const)(
  "worktree deletion follows %s session exit state in an open panel",
  async (kind) => {
    const view = setup();
    act(() => {
      view.base.update("a", { kind });
    });
    fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
    const item = () => view.getByRole("menuitem", { name: "Delete worktree…" });
    expect(item().hasAttribute("disabled")).toBe(true);
    fireEvent.click(item());
    expect(view.command).not.toHaveBeenCalled();
    act(() => {
      view.base.update("a", { exited: true });
    });
    expect(item().hasAttribute("disabled")).toBe(false);
    act(() => {
      view.base.update("a", { exited: false });
    });
    expect(item().hasAttribute("disabled")).toBe(true);
    act(() => {
      view.base.update("a", { exited: true });
    });
    await act(async () => {
      fireEvent.click(item());
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({
      kind: "remove-worktree",
      repository: "/foom",
      worktree: "/tree",
    });
  },
);

test("running and exited sessions have distinct actions", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Stop Claude Code" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "stop", id: "a" });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "shell", exited: true, state: "done" });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Shell in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Restart shell" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "restart", id: "a" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Shell in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Close" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "close", id: "a" });
});

test("F2 renames the focused session without sending keys to its terminal and add failures are visible", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Build helper" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Build helper" },
  });
  expect(row.textContent).toContain("Build helper");
  view.add.mockRejectedValueOnce(Error("denied"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add repository" }));
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toBe("Unable to add repository.");
});

test("restarting a renamed shell preserves its name and presents the replacement session", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "shell", state: "done", exited: true });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing row");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Tests" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  view.command.mockImplementationOnce(() => {
    view.base.update("a", { id: "replacement", exited: false, state: "working" });
    return Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Tests in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Restart shell" }));
    await Promise.resolve();
  });
  expect(view.getByRole("region", { name: "Terminal pane" }).textContent).toContain("Tests");
  expect(view.getByRole("button", { name: "Actions for Tests in feature" })).toBeTruthy();
});

test("wait labels follow attention and unnamed shells have a plain launcher label", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelector(".board-wait")).not.toBeNull();
  act(() => {
    view.base.update("a", { state: "working" });
  });
  expect(view.container.querySelector(".board-wait")).toBeNull();
  act(() => {
    view.base.update("a", { state: "needs_input", waitingSince: Date.now() });
  });
  expect(view.container.querySelector(".board-wait")?.textContent).toBe("0s");
  expect(launcherActions(undefined, undefined)).toEqual([
    { label: "Shell", badge: ">_", run: "shell" },
  ]);
});

test("main-checkout session breadcrumbs identify the checkout rather than its branch", async () => {
  const view = setup(true);
  await act(async () => {
    await Promise.resolve();
  });
  const checkout = view.getByRole("treeitem", { name: "Main checkout" });
  const session = checkout.querySelector(".board-row");
  if (!session) throw new Error("Missing main-checkout session");
  fireEvent.click(session);
  expect(view.getByRole("heading", { name: "Foom › Main checkout › Claude Code" })).toBeTruthy();
});

test("bypass launches have a neutral glyph and text in the session row", () => {
  const view = setup();
  const badge = view.getByText("Bypass");
  expect(badge.className).toBe("session-bypass");
  expect(badge.closest(".board-row")?.getAttribute("aria-label")).toContain("Bypass");
  expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe("◇");
});

test.each([false, true])(
  "marks development builds with neutral sidebar text (%s)",
  (isDevelopment) => {
    const source = { ...createSampleSource([]), isDevelopment };
    const view = render(<Board source={source} />);
    expect(view.queryByText("Dev") !== null).toBe(isDevelopment);
    expect(view.getByRole("heading", { name: isDevelopment ? "foom dev" : "foom" })).toBeTruthy();
  },
);

test.each(["shell", "agent"] as const)(
  "removed checkouts retain %s sessions without launch actions",
  async (kind) => {
    const view = setup();
    await act(async () => {
      await Promise.resolve();
    });
    const rows = view.source.getSnapshot().map((row) => ({
      ...row,
      kind,
      agent: kind === "shell" ? "shell" : "claude",
      conversationId: kind === "agent" ? "saved-conversation" : undefined,
      exited: true,
      worktreeRemoved: true,
    }));
    const source = {
      ...view.source,
      getSnapshot: () => rows,
      getSidebar: () => [
        { ...repository, worktrees: repository.worktrees.filter((tree) => tree.path === "/foom") },
      ],
    };
    view.rerender(<Board source={source} />);
    expect(view.getAllByText("Worktree removed").length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: "Actions for feature" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "feature" }));
    expect(view.container.querySelector(".location-launchers")).toBeNull();
    expect(view.queryByLabelText("feature details and commands")).toBeNull();
    fireEvent.click(
      view.getByRole("button", {
        name: `Actions for ${kind === "shell" ? "Shell" : "Claude Code"} in feature`,
      }),
    );
    expect(view.queryByRole("menuitem", { name: "Restart shell" })).toBeNull();
    expect(view.queryByRole("menuitem", { name: /^Resume conversation/ })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "New conversation here" })).toBeNull();
    if (kind === "agent")
      expect(view.getByRole("menuitem", { name: "Copy session ID" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Close" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({ kind: "close", id: "a" });
  },
);

test.each([
  ["claude", "CC", "Claude Code"],
  ["codex", "CX", "Codex"],
  ["agy", "AG", "Antigravity"],
  ["Claude Code", "CC", "Claude Code"],
  ["Codex", "CX", "Codex"],
  ["Antigravity", "AG", "Antigravity"],
  ["future-agent", "?", "future-agent"],
  ["constructor", "?", "constructor"],
  ["__proto__", "?", "__proto__"],
  ["", "?", "Unknown agent"],
  ["shell", ">_", "Shell (zsh)"],
  ["Shell", ">_", "Shell (zsh)"],
])("%s retains identity after rename without loading artwork", async (agent, mark, identity) => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { agent });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Build helper" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(row.getAttribute("aria-label")).toContain(`Build helper · ${identity}`);
  expect(row.querySelector(".board-agent")?.textContent).toBe(mark);
  expect(row.querySelector(".board-agent")?.getAttribute("aria-hidden")).toBe("true");
  expect(row.querySelector(".board-agent img, .board-agent svg")).toBeNull();
  const light = row.querySelector(".board-light");
  fireEvent.focus(row);
  expect(view.queryByRole("complementary", { name: "Terminal peek" })).toBeNull();
  fireEvent.blur(row);
  fireEvent.mouseEnter(row);
  expect(view.queryByRole("complementary", { name: "Terminal peek" })).toBeNull();
  expect(row.querySelector(".board-light")).toBe(light);
  fireEvent.click(row);
  expect(view.container.querySelector(".tile-title .board-agent")?.textContent).toBe(mark);
});

test("shell kind keeps the generic glyph and detected name even with another program identity", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "bash" });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  expect(row.querySelector(".board-agent")?.textContent).toBe(">_");
  expect(row.getAttribute("aria-label")).toContain("Shell (zsh)");
  fireEvent.click(row);
  expect(view.container.querySelector(".tile-title .board-agent")?.textContent).toBe(">_");
  view.rerender(<Board source={{ ...view.source, shellName: () => "" }} />);
  expect(row.getAttribute("aria-label")).toContain(" · Shell · ");
});

test("sessions offer Make and Revoke orchestrator; children offer Take over and panels show actions", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const row = {
    ...original,
    repository: "Foom",
    repositoryPath: "/foom",
    kind: "agent" as const,
    agent: "claude",
    managed: true,
    exited: false,
  };
  const base = createSampleSource([
    {
      ...row,
      id: "parent",
      worktree: "/foom",
      branch: "main",
      orchestration: {
        role: "orchestrator",
        active: true,
        children: 1,
        history: [
          { id: "o1", action: "launch", label: "feature", status: "succeeded", at: 1 },
          { id: "o2", action: "remove_worktree", label: "old", status: "failed", at: 2 },
        ],
      },
    },
    {
      ...row,
      id: "child",
      worktree: "/tree",
      branch: "feature",
      orchestration: { role: "child", parentId: "parent", takenOver: false },
    },
  ]);
  const command = vi.fn(() => Promise.resolve());
  const source: BoardSource = {
    ...base,
    getSidebar: () => [repository],
    shellName: () => "zsh",
    sidebarCommand: command,
    worktrees: {
      load: () =>
        Promise.resolve({
          repositories: [repository],
          agents: [
            { ...installation("claude"), mcp: false },
            { ...installation("codex"), mcp: true },
            { ...installation("agy"), path: "/agy", cliGuidance: true },
          ],
          enabled: { claude: true, codex: false, agy: true },
          hooks: true,
        }),
      addRepository: () => Promise.resolve(null),
      branches: () =>
        Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
      create: vi.fn(),
      remove: () => Promise.resolve(true),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.queryByRole("menuitem", { name: /orchestrator/u })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  expect(view.getByText(/Can send input, stop and read this session/u)).toBeTruthy();
  expect(view.queryByRole("menuitem", { name: "Reset reviewed replies" })).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Take over" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "take-over", id: "child" });
  act(() => {
    base.update("child", { orchestration: { role: "child", parentId: "parent", takenOver: true } });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  expect(view.queryByRole("menuitem", { name: "Take over" })).toBeNull();
  expect(view.getByText(/You took over/u)).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Make orchestrator…" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "make-orchestrator", id: "child" });
  fireEvent.click(
    view.getByRole("button", { name: /^Actions for Claude Code in (main|Main checkout)$/u }),
  );
  expect(view.queryByRole("menuitem", { name: "Make orchestrator…" })).toBeNull();
  expect(view.getByText("Active")).toBeTruthy();
  expect(view.getByText(/1 child running/u)).toBeTruthy();
  const actions = document.querySelector(".panel-actions");
  expect(actions?.textContent).toContain("Remove worktree old · failed");
  expect(actions?.textContent).toContain("Launch feature · done");
  expect(actions?.querySelector('[data-status="failed"]')).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Revoke orchestrator" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "revoke-orchestrator", id: "parent" });
});

test.each([
  [false, 0, false],
  [true, 0, false],
  [false, 2, false],
  [true, 2, false],
  [false, 0, true],
  [true, 0, true],
  [false, 2, true],
  [true, 2, true],
] as const)("config dock: held=%s rejected=%s session=%s", async (held, rejected, hasSession) => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const row = { ...original, id: "config-session", config: true, exited: false };
  const status = {
    folder: "/config",
    available: true,
    rejected: Array.from({ length: rejected }, (_, n) => ({
      file: `themes/${String(n)}.json`,
      reason: "$: malformed-json",
    })),
    pending: held
      ? { id: "held", action: "turn off alerts", file: "settings.json", detail: "alerts" }
      : null,
  };
  const base = createSampleSource(hasSession ? [row] : []);
  const source: BoardSource = {
    ...base,
    config: {
      status: () => Promise.resolve(status),
      subscribe: () => () => {},
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  const gear = view.container.querySelector<HTMLButtonElement>(".config-gear");
  if (!gear) throw Error("gear");
  expect(gear.getAttribute("aria-label")).toBe(
    `Foom config${held ? ", needs you" : ""}${rejected ? ", 2 rejected" : ""}`,
  );
  expect(gear.getAttribute("data-tone")).toBe(held ? "needs" : rejected ? "failed" : null);
  expect(gear.title).toBe("Foom config");
  expect(view.queryByRole("treeitem", { name: "Foom config" })).toBeNull();
  const dock = view.container.querySelector(".config-dock");
  expect(Boolean(dock)).toBe(held || rejected > 0 || hasSession);
  expect(dock?.querySelector(".config-dock-head")?.textContent.includes("Needs you") ?? false).toBe(
    held,
  );
  expect(dock?.textContent.includes("2 rejected") ?? false).toBe(rejected > 0);
  expect(view.container.querySelector(".board-summary")?.textContent).toContain(
    `${String((held ? 1 : 0) + (hasSession && row.state === "needs_input" ? 1 : 0))} need you`,
  );
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Foom config" },
  });
  expect(view.queryByRole("treeitem", { name: "Foom config" })).toBeNull();
  if (hasSession) {
    const session = view.container.querySelector<HTMLElement>(".config-dock .board-row");
    if (!session) throw Error("session");
    expect(session.tabIndex).toBe(0);
    fireEvent.keyDown(session, { key: "Enter" });
    expect(view.container.querySelector(".terminal-tile[data-empty=false]")).toBeTruthy();
    fireEvent.keyDown(session, { key: "F10", shiftKey: true });
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  }
  fireEvent.click(gear);
  expect(gear.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  expect(gear.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  const count = (held ? 1 : 0) + (hasSession && row.state === "needs_input" ? 1 : 0);
  expect(view.container.querySelector(".rail-needs")?.textContent ?? "").toBe(
    count ? `${String(count)} need you` : "",
  );
  expect(view.container.querySelector(".config-dock")).toBeNull();
  if (hasSession) expect(view.container.querySelector(".board-list .board-row")).toBeTruthy();
});

test("marks children in their own checkouts, highlights relationships and retains parent context", () => {
  const original = sampleRows(0)[0];
  if (!original) throw new Error("Missing sample");
  const parent: BoardRow = {
    ...original,
    id: "parent",
    kind: "agent",
    agent: "claude",
    repository: "Foom",
    repositoryPath: "/foom",
    worktree: "/foom",
    branch: "main",
    exited: true,
    orchestration: { role: "orchestrator", active: false, children: 1, history: [] },
  };
  const child: BoardRow = {
    ...parent,
    id: "child",
    agent: "codex",
    worktree: "/tree",
    branch: "feature",
    exited: false,
    state: "needs_input",
    orchestration: { role: "child", parentId: "parent", takenOver: false },
  };
  const base = createSampleSource([parent, child]);
  const revealRef: { current: ((row: BoardRow) => void) | undefined } = { current: undefined };
  const save = vi.fn<(next: SidebarPreferences) => void>();
  const open = vi.fn();
  const props = {
    source: { ...base, getSidebar: () => [repository] },
    rows: base.getSnapshot(),
    selected: "parent",
    filter: "",
    setFilter: vi.fn(),
    preferences: emptyPreferences(),
    save,
    open,
    focus: vi.fn(),
    buttons: { current: new Map<string, HTMLDivElement>() },
    now: 0,
    inactive: false,
    revealRef,
    sidebar: { current: null },
    command: vi.fn(() => Promise.resolve()),
    options: undefined,
    footer: null,
  };
  const view = render(<Sidebar {...props} />);
  const item = view.getByRole("treeitem", { name: /feature · Codex/u });
  const parentItem = view.getByRole("treeitem", { name: /main · Claude Code/u });
  expect(
    item.querySelector('.session-robot-mark[data-kind="rx"]')?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(item.querySelector(".session-robot-mark")?.getAttribute("data-related")).toBe("true");
  expect(parentItem.querySelector('.session-robot-mark[data-kind="tx"]')).toBeTruthy();
  expect(view.container.querySelector(".session-child-mark")).toBeNull();
  expect(item.title).toBe("Child of Claude Code");
  expect(item.closest(".session-entry")?.getAttribute("data-related")).toBe("true");
  expect(item.closest('[role="group"]')?.contains(parentItem)).toBe(false);
  fireEvent.pointerEnter(item.closest(".session-entry") ?? item);
  expect(parentItem.closest(".session-entry")?.getAttribute("data-related")).toBe("true");
  fireEvent.pointerLeave(item.closest(".session-entry") ?? item);
  expect(parentItem.closest(".session-entry")?.getAttribute("data-related")).toBe("false");
  fireEvent.focus(item);
  expect(parentItem.closest(".session-entry")?.getAttribute("data-related")).toBe("true");
  fireEvent.blur(item);
  expect(parentItem.closest(".session-entry")?.getAttribute("data-related")).toBe("false");
  expect(view.getByText("Exited orchestrator")).toBeTruthy();
  expect(view.queryByText("Taken over")).toBeNull();
  fireEvent.keyDown(item, { key: "Enter" });
  expect(open).toHaveBeenCalledWith(child);
  fireEvent.keyDown(item, { key: " " });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "ArrowUp" });
  expect(document.activeElement).not.toBe(item);
  view.rerender(<Sidebar {...props} rows={[{ ...parent, exited: false }, child]} />);
  expect(view.getByText("Revoked orchestrator")).toBeTruthy();
  const collapsed = { ...props.preferences, expanded: { "worktree:/foom": false } };
  view.rerender(<Sidebar {...props} preferences={collapsed} />);
  expect(view.queryByRole("group", { name: "Children of Claude Code" })).toBeNull();
  act(() => {
    revealRef.current?.(child);
  });
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expanded: { "worktree:/foom": false, "repository:/foom": true, "worktree:/tree": true },
    }),
  );
  view.rerender(<Sidebar {...props} rows={[child]} />);
  expect(view.container.querySelector('.session-robot-mark[data-kind="orphan"]')).toBeTruthy();
  expect(view.container.querySelector(".session-robot-mark")?.getAttribute("data-related")).toBe(
    "false",
  );
  view.rerender(
    <Sidebar
      {...props}
      rows={[{ ...child, orchestration: { role: "child", parentId: "parent", takenOver: true } }]}
    />,
  );
  expect(view.container.querySelector(".session-robot-mark")).toBeNull();
  expect(view.getByRole("treeitem", { name: /feature · Codex/u }).title).toBe(
    "Child of parent · Taken over",
  );
  view.unmount();
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const compact = render(<Sidebar {...props} />);
  expect(compact.getAllByRole("treeitem", { name: /feature · Codex/u })).toHaveLength(1);
  expect(compact.queryByRole("group", { name: "Children of Claude Code" })).toBeNull();
  expect(compact.container.querySelectorAll(".session-robot-mark")).toHaveLength(2);
  expect(compact.container.querySelector(".session-lines .session-robot-mark")).toBeNull();
  compact.rerender(<Sidebar {...props} rows={[{ ...child, orchestration: undefined }]} />);
  expect(compact.container.querySelector(".session-robot-mark")).toBeNull();
  compact.unmount();
  vi.unstubAllGlobals();
});
