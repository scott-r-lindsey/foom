// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PanelFacts, PanelTitle } from "../../../../src/renderer/board/panel-facts";
import type { PanelSubject } from "../../../../src/renderer/board/panel-facts";
import type { GitPanelFacts } from "../../../../src/shared/panel";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows } from "../../../fixtures/board";
const source = createSampleSource([]);
const row = boardRows(0)[0];
if (!row) throw Error("fixture");
const tree = {
  path: "/tree",
  head: "123456789",
  branch: null,
  managed: false,
  bare: false,
  locked: false,
  prunable: false,
};
const repository = { path: "/repo", name: "Repo", worktrees: [tree], mergedCount: 2 };
const facts: GitPanelFacts = {
  changes: 0,
  upstream: { ahead: 2, behind: 1 },
  commit: { hash: "123456789", subject: "Last change", timestamp: 1000 },
  remote: "origin",
  defaultBranch: "main",
  lastFetch: 1000,
  fetchFailed: false,
  merged: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("renders local facts, unknowns, state chips and copy buttons", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const live = {
    ...source,
    sidebarCommand: writeText,
    panelFacts: vi.fn(() => Promise.resolve(facts)),
  };
  const view = render(
    <PanelFacts
      subject={{ kind: "repository", repository, rows: [row] }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("main");
  expect(view.container.textContent).toContain("2 eligible");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith({
    kind: "copy-worktree-path",
    repository: "/repo",
    worktree: "/repo",
  });
  expect(view.getByRole("status").textContent).toBe("Copied");
  writeText.mockRejectedValueOnce(Error("denied"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("Unable to copy");
  view.rerender(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Detached at 1234567");
  expect(view.container.textContent).toContain("Clean");
  expect(view.container.textContent).toContain("2 ahead · 1 behind");
  expect(view.container.textContent).toContain("Last change");
  expect(view.container.textContent).toContain("Merged into default branch");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/tree" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({
    kind: "copy-worktree-path",
    repository: "/repo",
    worktree: "/tree",
  });
  view.rerender(
    <PanelFacts
      subject={{
        kind: "home",
        home: { directory: "/home/me", path: "/bin/bash", version: null },
        rows: [],
      }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/home/me" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({ kind: "copy-home-path" });
  view.rerender(
    <PanelFacts
      subject={{
        kind: "session",
        row: { ...row, conversationId: "conversation" },
        tile: undefined,
      }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "conversation" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({ kind: "copy-session-id", id: row.id });
  view.rerender(
    <PanelFacts
      subject={{ kind: "repository", repository, rows: [] }}
      source={source}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("Unable to copy");
});
test.each([false, true])(
  "Created by Foom uses an unpunctuated label and explicit value (%s)",
  async (managed) => {
    const view = render(
      <PanelFacts
        subject={{ kind: "worktree", repository, tree: { ...tree, managed } }}
        source={source}
        options={undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByText("Created by Foom", { exact: true }).nextElementSibling?.textContent).toBe(
      managed ? "Yes" : "No",
    );
    expect(view.queryByText("Created by Foom:", { exact: true })).toBeNull();
  },
);

test("all row types remain useful without available facts", async () => {
  const subjects: PanelSubject[] = [
    { kind: "home", home: undefined, rows: [] },
    {
      kind: "home",
      home: { directory: "/home/me", path: "/bin/bash", version: "Bash 5" },
      rows: [row],
    },
    { kind: "repository", repository, rows: [] },
    { kind: "worktree", repository, tree: { ...tree, head: null, path: repository.path } },
    { kind: "worktree", repository, tree: { ...tree, branch: "feature", managed: true } },
    { kind: "session", row, tile: undefined },
    {
      kind: "session",
      row: {
        ...row,
        home: true,
        kind: "shell",
        exited: true,
        conversationId: "session-id",
        exitCode: 0,
      },
      tile: 2,
    },
    {
      kind: "session",
      row: { ...row, state: "working", startedAt: 1000, launchFlags: ["--verbose"], bypass: true },
      tile: 1,
    },
  ];
  for (const subject of subjects) {
    const view = render(<PanelFacts subject={subject} source={source} options={undefined} />);
    expect(view.container.querySelector("dt")).toBeTruthy();
    view.unmount();
  }
  const failed = { ...source, panelFacts: () => Promise.reject(Error("git failed")) };
  const view = render(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree }}
      source={failed}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Unknown");
});
test("title edits commit on blur or Enter and Escape cancels", () => {
  const save = vi.fn();
  const view = render(<PanelTitle name="Helper" save={save} />);
  fireEvent.click(view.getByRole("button"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Changed" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Escape" });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "" } });
  fireEvent.blur(view.getByLabelText("Session name"));
  expect(save).toHaveBeenLastCalledWith("");
  fireEvent.click(view.getByRole("button"));
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "a" });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(save).toHaveBeenLastCalledWith("Helper");
});

test("fact chips keep amber for needs-you, magenta for failures and name every state", async () => {
  const tones = (view: ReturnType<typeof render>) =>
    Array.from(view.container.querySelectorAll(".panel-chip"), (chip) => [
      chip.getAttribute("data-tone"),
      chip.textContent,
    ]);
  const now = Date.now();
  const stale = {
    ...facts,
    changes: 3,
    upstream: { ahead: 0, behind: 0 },
    commit: {
      hash: "abcdef123",
      subject: "Old",
      timestamp: now - 3 * 3_600_000,
    },
    lastFetch: now - 5 * 86_400_000,
    merged: false,
  } satisfies GitPanelFacts;
  const live = { ...source, panelFacts: vi.fn(() => Promise.resolve(stale)) };
  const linked = { ...tree, branch: "main", managed: true };
  const view = render(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree: linked }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(tones(view)).toEqual([
    ["neutral", "default"],
    ["changes", "3 changed"],
    ["neutral", "Not merged into default branch"],
    ["info", "Yes"],
  ]);
  expect(view.container.textContent).toContain("In sync");
  expect(view.container.textContent).toContain("3 h ago");
  live.panelFacts.mockResolvedValue({ ...stale, fetchFailed: true });
  view.rerender(
    <PanelFacts
      subject={{ kind: "repository", repository: { ...repository, mergedCount: 0 }, rows: [] }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(tones(view)).toEqual([
    ["failed", "Fetch failed"],
    ["neutral", "0 by Foom"],
    ["neutral", "0 eligible to delete"],
  ]);
  live.panelFacts.mockResolvedValue(stale);
  view.rerender(
    <PanelFacts
      subject={{ kind: "repository", repository: { ...repository, path: "/other" }, rows: [] }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("fetched 5 days ago");
  view.rerender(
    <PanelFacts
      subject={{ kind: "session", row: { ...row, state: "needs_input" }, tile: 3 }}
      source={live}
      options={undefined}
    />,
  );
  expect(tones(view).map(([tone]) => tone)).toEqual(["needs", "needs", "info"]);
  view.rerender(
    <PanelFacts
      subject={{
        kind: "session",
        row: { ...row, state: "failed", exited: true, exitCode: 1 },
        tile: undefined,
      }}
      source={live}
      options={undefined}
    />,
  );
  expect(tones(view)).toEqual([
    ["failed", "Exited · Failed"],
    ["failed", "1"],
  ]);
});

test.each(["connecting", "connected", "not-connected"] as const)(
  "shows MCP %s in session panels and reserves failure tone for orchestrators",
  (mcpConnection) => {
    const label = {
      connecting: "Connecting…",
      connected: "Connected",
      "not-connected": "Not connected",
    }[mcpConnection];
    const base = { ...row, mcpConnection };
    const view = render(
      <PanelFacts
        subject={{ kind: "session", row: base, tile: undefined }}
        source={source}
        options={undefined}
      />,
    );
    expect(view.getByText(label).getAttribute("data-tone")).toBe("neutral");
    view.rerender(
      <PanelFacts
        subject={{
          kind: "session",
          row: {
            ...base,
            orchestration: { role: "orchestrator", active: true, children: 0, history: [] },
          },
          tile: undefined,
        }}
        source={source}
        options={undefined}
      />,
    );
    expect(view.getByText(label).getAttribute("data-tone")).toBe(
      mcpConnection === "not-connected" ? "failed" : "neutral",
    );
  },
);

test.each(["done", "blocked", "failed"] as const)(
  "displays %s handoffs as inert text and links with scoped commands",
  (status) => {
    const sidebarCommand = vi.fn(() => Promise.resolve());
    const report = {
      seq: 2,
      status,
      summary: "<img src=x>\n**Not Markdown**",
      links: ["https://example.com/pr/1"],
      timestamp: "2026-10-15T00:00:00.000Z",
    };
    const view = render(
      <PanelFacts
        subject={{ kind: "session", row: { ...row, handoff: report }, tile: undefined }}
        source={{ ...source, sidebarCommand }}
        options={undefined}
      />,
    );
    expect(view.container.querySelector(".handoff-summary")?.textContent).toBe(report.summary);
    expect(view.container.querySelector(".handoff-summary img")).toBeNull();
    fireEvent.click(view.getByRole("link"));
    expect(sidebarCommand).toHaveBeenCalledWith({
      kind: "open-handoff-link",
      id: row.id,
      seq: 2,
      index: 0,
    });
  },
);

test("reports a failed handoff link action without unhandled rejection", async () => {
  const view = render(
    <PanelFacts
      subject={{
        kind: "session",
        row: {
          ...row,
          handoff: {
            seq: 1,
            status: "done",
            summary: "Done",
            links: ["https://example.com"],
            timestamp: "2026-10-15T00:00:00.000Z",
          },
        },
        tile: undefined,
      }}
      source={{ ...source, sidebarCommand: () => Promise.reject(new Error("gone")) }}
      options={undefined}
    />,
  );
  fireEvent.click(view.getByRole("link"));
  expect(await view.findByText("Unable to open this handoff link.")).toBeDefined();
});

test("checkout panel renders a plain PR title, state and complete check counts", () => {
  const pullRequest = {
    number: 12,
    title: "<b>Untrusted title</b>",
    url: "https://github.com/o/r/pull/12",
    state: "OPEN" as const,
    checks: { passed: 2, failed: 1, pending: 3 },
  };
  const view = render(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree: { ...tree, pullRequest } }}
      source={source}
      options={undefined}
    />,
  );
  expect(view.getByText("#12 · <b>Untrusted title</b>")).toBeTruthy();
  expect(view.getByText("2 passed · 1 failed · 3 running")).toBeTruthy();
  expect(view.container.querySelector("b")).toBeNull();
  view.rerender(
    <PanelFacts
      subject={{
        kind: "worktree",
        repository,
        tree: { ...tree, pullRequest: { ...pullRequest, checks: null } },
      }}
      source={source}
      options={undefined}
    />,
  );
  expect(view.getByText("Checks").nextElementSibling?.textContent).toBe("Unknown");
});

test("repository facts count waiting parents without conflating child counts", async () => {
  const waiting = { ...row, state: "waiting" as const, waitingOn: 3 };
  const view = render(
    <PanelFacts
      subject={{
        kind: "repository",
        repository,
        rows: [waiting, { ...waiting, id: "second", waitingOn: 1 }],
      }}
      source={source}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.getByText("2 waiting").getAttribute("data-tone")).toBe("neutral");
});

test("the config panel offers the held digest's existing Allow/Keep decision", async () => {
  const pending = {
    id: "held-digest",
    file: "settings.json",
    action: "change FixtureCode launch arguments",
    detail: "agentArguments.fixturecode",
  };
  const status = { folder: "/config", available: true, pending, rejected: [] };
  const decide = vi.fn(() => Promise.resolve({ ...status, pending: null }));
  const live = {
    ...source,
    config: {
      status: () => Promise.resolve(status),
      subscribe: () => () => {},
      openFolder: () => Promise.resolve(),
      decide,
    },
  };
  const view = render(
    <PanelFacts subject={{ kind: "config", status, rows: [] }} source={live} options={undefined} />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Allow$/ }));
    await Promise.resolve();
  });
  expect(decide).toHaveBeenCalledWith("allow", "held-digest");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Keep it on" }));
    await Promise.resolve();
  });
  expect(decide).toHaveBeenCalledWith("keep", "held-digest");
  view.rerender(
    <PanelFacts
      subject={{ kind: "config", status: { ...status, pending: null }, rows: [] }}
      source={live}
      options={undefined}
    />,
  );
  expect(view.queryByText("Needs you")).toBeNull();
});

test("labels the relevant check conclusion separately from all-check counts", async () => {
  for (const [checksMeaning, label] of [
    ["required", "Required checks"],
    ["head-pipeline", "Head pipeline"],
    ["commit-status", "Commit status"],
  ] as const) {
    const view = render(
      <PanelFacts
        subject={{
          kind: "worktree",
          repository,
          tree: {
            ...tree,
            pullRequest: {
              number: 12,
              title: "<b>Title</b>",
              state: "OPEN",
              checks: { passed: 1, failed: 1, pending: 0 },
              checksMeaning,
              requiredChecks: "success",
            },
          },
        }}
        source={source}
        options={undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByText(label)).toBeTruthy();
    expect(view.getByText("success")).toBeTruthy();
    expect(view.getByText("1 passed · 1 failed · 0 running")).toBeTruthy();
    expect(view.container.querySelector("b")).toBeNull();
    view.unmount();
  }
  const view = render(
    <PanelFacts
      subject={{
        kind: "worktree",
        repository,
        tree: {
          ...tree,
          pullRequest: { number: 12, state: "OPEN", checks: null, checksMeaning: "head-pipeline" },
        },
      }}
      source={source}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.getByText("#12")).toBeTruthy();
  expect(view.getByText("unknown")).toBeTruthy();
});
