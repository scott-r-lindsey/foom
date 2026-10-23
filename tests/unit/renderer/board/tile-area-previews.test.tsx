// @vitest-environment jsdom
import { act, fireEvent, render, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import {
  TILE_STORAGE,
  initialLayout,
  leaves,
  placeContent,
  placeSession,
  saveLayout,
} from "../../../../src/renderer/board/tiles";
import type { BoardCommand } from "../../../../src/shared/board-command";
import type { PreviewSummary } from "../../../../src/shared/workspace";
import { boardRows as sampleRows } from "../../../fixtures/board";
import { arrangedLayout } from "../../../fixtures/tile-layout";
import { registerTileAreaFixture } from "./tile-area-fixture";

registerTileAreaFixture();

test.each(["markdown", "html"] as const)(
  "%s previews share numbering, focus and tile commands without terminal attachment",
  async (kind) => {
    const data = createSampleSource(sampleRows(100).slice(0, 1));
    const row = data.getSnapshot()[0];
    if (!row) throw new Error("Missing row");
    const preview = {
      id: "preview",
      repository: row.repository,
      worktree: `${row.repository}/${row.branch}`,
      network: false,
      relativePath: "docs/test.md",
      kind,
    };
    const terminal = placeSession(arrangedLayout(initialLayout(), "columns"), row.id);
    if (!terminal) throw new Error("Missing terminal");
    const layout = placeContent(terminal, { kind: "preview", preview: preview.id });
    if (!layout) throw new Error("Missing preview");
    saveLayout(localStorage, { ...layout, focused: terminal.focused });
    const close = vi.fn(() => Promise.resolve());
    const network = vi.fn(async () => {});
    let command: ((command: BoardCommand) => void) | undefined;
    const source: BoardSource = {
      ...data,
      previews: {
        getSnapshot: () => [preview],
        pick: vi.fn(() => Promise.resolve(null)),
        bounds: vi.fn(async () => {}),
        close,
        network,
      },
      subscribeCommands: (listener) => {
        command = listener;
        return () => {
          command = undefined;
        };
      },
    };
    const screen = render(<Board source={source} />);
    const tile = screen.getByRole("region", { name: "Tile 2: docs/test.md" });
    expect(tile.querySelector(".board-light")).toBeNull();
    expect(tile.querySelector(".board-agent")?.textContent).toBe(
      kind === "markdown" ? "MD" : "HTML",
    );
    const sidebarRow = screen.getByRole("treeitem", { name: /preview: docs\/test.md/ });
    expect(within(sidebarRow).getByLabelText("Tile 2")).toBeTruthy();
    act(() => {
      command?.("tile-2");
    });
    expect(tile.getAttribute("data-focused")).toBe("true");
    fireEvent.click(within(sidebarRow).getByRole("button"));
    await act(async () => {});
    expect(tile.getAttribute("data-focused")).toBe("true");
    expect(document.activeElement).toBe(tile);
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    expect(screen.queryByRole("menuitem", { name: "Hide" })).toBeNull();
    expect(
      screen.getByText(kind === "markdown" ? "Markdown" : "HTML", { selector: "dd" }),
    ).toBeTruthy();
    expect(screen.getByText("Off", { selector: "dd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow network…" }));
    await act(async () => {});
    expect(network).toHaveBeenCalledWith("preview", true);
    preview.network = true;
    screen.rerender(<Board source={{ ...source }} />);
    expect(within(tile).getByText("network")).toBeTruthy();
    within(tile).getByRole("button", { name: "Tile 2 menu" }).focus();
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    expect(screen.getByText("On", { selector: "dd" })).toBeTruthy();
    network.mockRejectedValueOnce(
      kind === "markdown" ? new Error("Network unavailable") : "failed",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Block network" }));
    await act(async () => {});
    expect(network).toHaveBeenCalledWith("preview", false);
    expect(screen.getByRole("alert").textContent).toBe("Network change failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("dialog", { name: "Action failed" })).toBeNull();
    expect(document.activeElement).toBe(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Maximize/ }));
    expect(tile.getAttribute("data-maximized")).toBe("true");
    fireEvent.click(within(tile).getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(close).toHaveBeenCalledExactlyOnceWith("preview");
    expect(tile.getAttribute("data-empty")).toBe("true");
  },
);
test("replacing a preview closes it and reports close failures", async () => {
  const data = createSampleSource(sampleRows(100).slice(0, 1));
  const preview = {
    id: "p",
    repository: "Foom",
    worktree: "/tree",
    network: false,
    relativePath: "page.html",
    kind: "html" as const,
  };
  const layout = placeContent(initialLayout(), { kind: "preview", preview: "p" });
  if (!layout) throw new Error("Missing preview");
  saveLayout(localStorage, layout);
  const close = vi.fn(() => Promise.reject(new Error("closed")));
  const screen = render(
    <Board
      source={{
        ...data,
        previews: {
          getSnapshot: () => [preview],
          pick: vi.fn(() => Promise.resolve(null)),
          bounds: vi.fn(async () => {}),
          close,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("Unable to close preview.");
});

test.each(["claude", "custom"])(
  "agent %s preview chrome identifies the opener and nests a sidebar-only row that the human can show",
  async (agent) => {
    const data = createSampleSource(
      sampleRows(100)
        .slice(0, 1)
        .map((row) => ({ ...row, agent })),
    );
    const row = data.getSnapshot()[0];
    if (!row) throw new Error("Missing row");
    const first = {
      id: "first",
      repository: row.repository,
      worktree: `${row.repository}/${row.branch}`,
      relativePath: "docs/first.html",
      kind: "html" as const,
      network: false,
      openedBy: { terminalId: row.id, agent },
    };
    const second = {
      ...first,
      id: "second",
      relativePath: "docs/second.md",
      kind: "markdown" as const,
    };
    const layout = placeContent(initialLayout(), { kind: "preview", preview: first.id });
    if (!layout) throw new Error("Missing layout");
    saveLayout(localStorage, layout);
    const close = vi.fn(() => Promise.resolve());
    const screen = render(
      <Board
        source={{
          ...data,
          previews: {
            getSnapshot: () => [first, second],
            pick: () => Promise.resolve(null),
            bounds: () => Promise.resolve(),
            close,
            getHistory: () => [
              { id: "event", terminalId: row.id, path: first.relativePath, at: 100 },
            ],
          },
        }}
      />,
    );
    const identity = agent === "claude" ? "Claude Code" : agent;
    const tile = screen.getByRole("region", {
      name: `Tile 1: docs/first.html, opened by ${identity}`,
    });
    expect(within(tile).getByText("opened by")).toBeTruthy();
    expect(tile.querySelector(".preview-opener .board-agent")?.textContent).toBe(
      agent === "claude" ? "CC" : "?",
    );
    const sidebar = screen.getByRole("treeitem", {
      name: `Markdown preview: docs/second.md, opened by ${identity}, not shown`,
    });
    expect(sidebar.querySelector('[data-child="true"]')).toBeTruthy();
    expect(sidebar.parentElement?.querySelector(".board-row")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: `Actions for ${identity} in ${row.branch}` }),
    );
    expect(screen.getByText("Opened preview docs/first.html")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(sidebar).getByRole("button"));
    await act(async () => {});
    const shown = screen.getByRole("region", {
      name: `Tile 1: docs/second.md, opened by ${identity}`,
    });
    expect(shown.getAttribute("data-focused")).toBe("true");
    expect(close).toHaveBeenCalledWith("first");
    fireEvent.click(within(shown).getByRole("button", { name: "Tile 1 menu" }));
    expect(screen.getByText(identity, { selector: "dd" })).toBeTruthy();
  },
);

test("panel picking fills the landing spot without focus, and handles cancel and refusal", async () => {
  const data = createSampleSource(sampleRows(100).slice(1, 2));
  const row = data.getSnapshot()[0];
  if (!row) throw new Error("Missing row");
  const preview = {
    id: "picked",
    repository: row.repository,
    worktree: `${row.repository}/${row.branch}`,
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const pick = vi.fn(() => Promise.resolve<string | null>(preview.id));
  const bounds = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const occupied = placeSession(arrangedLayout(initialLayout(), "columns"), row.id);
  if (!occupied) throw new Error("Missing layout");
  const landing = leaves(occupied.tree).find((tile) => !tile.content);
  if (!landing) throw new Error("Missing landing spot");
  saveLayout(localStorage, { ...occupied, landing: landing.id });
  const screen = render(
    <Board source={{ ...data, previews: { getSnapshot: () => [preview], pick, bounds, close } }} />,
  );
  const choose = async () => {
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.branch}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Preview file…" }));
    await act(async () => {});
  };
  await choose();
  expect(pick).toHaveBeenCalledWith(preview.worktree);
  const tile = screen.getByRole("region", { name: "Tile 2: page.html" });
  expect(tile.getAttribute("data-tile")).toBe(landing.id);
  expect(tile.getAttribute("data-focused")).toBe("false");
  expect(bounds).toHaveBeenCalledWith(preview.id, expect.objectContaining({ visible: false }));
  pick.mockResolvedValueOnce(null);
  await choose();
  expect(close).not.toHaveBeenCalled();
  pick.mockRejectedValueOnce(new Error("Refused file"));
  await choose();
  expect(screen.getByRole("alert").textContent).toBe("Unable to open preview.");
});

test("preview bounds follow body measurement and transitions, hide under settings, and dispose observers", async () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(12, 34, 320, 180),
  );
  const preview = {
    id: "p",
    repository: "repo",
    worktree: "/tree",
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const layout = placeContent(initialLayout(), { kind: "preview", preview: preview.id });
  if (!layout) throw new Error("Missing layout");
  saveLayout(localStorage, layout);
  const bounds = vi.fn(() => Promise.resolve());
  bounds.mockRejectedValue(new Error("native view failed"));
  const source = {
    ...createSampleSource([]),
    getSidebar: () => [
      {
        path: "repo",
        name: "repo",
        worktrees: [
          {
            path: "/tree",
            head: "abc",
            branch: "main",
            bare: false,
            locked: false,
            prunable: false,
            managed: true,
          },
        ],
      },
    ],
    previews: {
      getSnapshot: () => [preview],
      pick: () => Promise.resolve(null),
      close: () => Promise.resolve(),
      bounds,
    },
  };
  const screen = render(<Board source={source} />);
  await act(async () => {});
  expect(screen.getByText("Unable to display preview.").textContent).toContain(
    "Unable to display preview.",
  );
  bounds.mockResolvedValue();
  const tile = screen.getByRole("region", { name: "Tile 1: page.html" });
  fireEvent(tile, new Event("transitionend"));
  fireEvent(window, new Event("resize"));
  await act(async () => {});
  expect(bounds).toHaveBeenLastCalledWith("p", {
    x: 12,
    y: 34,
    width: 320,
    height: 180,
    visible: true,
  });
  screen.rerender(<Board source={source} inactive />);
  await act(async () => {});
  expect(bounds).toHaveBeenLastCalledWith("p", expect.objectContaining({ visible: false }));
  bounds.mockRejectedValueOnce(new Error("already closed"));
  screen.unmount();
  await act(async () => {});
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  bounds.mockClear();
  fireEvent(window, new Event("resize"));
  expect(bounds).not.toHaveBeenCalled();
});

test("resizing a preview tile moves its native view without hiding it between steps", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const preview = {
    id: "p",
    repository: "repo",
    worktree: "/tree",
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const layout = placeContent(arrangedLayout(initialLayout(), "columns"), {
    kind: "preview",
    preview: preview.id,
  });
  if (!layout) throw new Error("Missing layout");
  saveLayout(localStorage, layout);
  const bounds = vi.fn(() => Promise.resolve());
  const screen = render(
    <Board
      source={{
        ...createSampleSource([]),
        previews: {
          getSnapshot: () => [preview],
          pick: () => Promise.resolve(null),
          close: () => Promise.resolve(),
          bounds,
        },
      }}
    />,
  );
  const area = screen.container.querySelector<HTMLElement>(".tile-area");
  if (!area) throw new Error("No area");
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 300),
  );
  fireEvent(window, new Event("resize"));
  await act(async () => {});
  bounds.mockClear();
  const gutter = screen.getAllByRole("separator", { name: "Resize tiles" })[0];
  if (!gutter) throw new Error("No gutter");
  for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home"])
    fireEvent.keyDown(gutter, { key });
  await act(async () => {});
  expect(bounds).toHaveBeenCalled();
  expect(bounds).not.toHaveBeenCalledWith("p", expect.objectContaining({ visible: false }));
  screen.unmount();
  expect(bounds).toHaveBeenLastCalledWith("p", expect.objectContaining({ visible: false }));
});

test("human previews on a full narrow board replace the eligible tile as human sessions do", async () => {
  const template = sampleRows(100)[1];
  if (!template) throw new Error("Missing row");
  const row = { ...template, state: "working" as const };
  const data = createSampleSource([row]);
  const preview = {
    id: "picked",
    repository: row.repository,
    worktree: `${row.repository}/${row.branch}`,
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const layout = placeSession(initialLayout(), row.id);
  if (!layout) throw new Error("Missing layout");
  saveLayout(localStorage, layout);
  const pick = vi.fn(() => Promise.resolve(preview.id));
  const screen = render(
    <Board
      source={{
        ...data,
        previews: {
          getSnapshot: () => [preview],
          pick,
          close: () => Promise.resolve(),
          bounds: () => Promise.resolve(),
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.branch}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Preview file…" }));
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Tile 1: page.html" }).getAttribute("data-tile")).toBe(
    layout.focused,
  );
});

test.each(["html", "markdown"] as const)(
  "%s preview popout routes its ID and reports failures",
  async (kind) => {
    const preview = {
      id: "preview",
      repository: "repo",
      worktree: "/tree",
      relativePath: kind === "html" ? "page.html" : "guide.md",
      kind,
      network: false,
      openedBy: { terminalId: "agent", agent: "claude" },
    };
    const layout = placeContent(initialLayout(), { kind: "preview", preview: preview.id });
    if (!layout) throw new Error("Missing layout");
    saveLayout(localStorage, layout);
    const popout = vi.fn(() => Promise.resolve());
    const source = {
      ...createSampleSource([]),
      previews: {
        getSnapshot: () => [preview],
        pick: () => Promise.resolve(null),
        close: () => Promise.resolve(),
        bounds: () => Promise.resolve(),
        popout,
      },
    };
    const screen = render(<Board source={source} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Tile 1 menu" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to new window" }));
      await Promise.resolve();
    });
    expect(popout).toHaveBeenCalledWith("preview");
    popout.mockRejectedValueOnce(new Error("window failed"));
    fireEvent.click(screen.getByRole("button", { name: "Tile 1 menu" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to new window" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Unable to move tile");
  },
);

test("preview placement waits for inventory without pruning the pending assignment", async () => {
  const data = createSampleSource(sampleRows(100).slice(1, 2));
  const row = data.getSnapshot()[0];
  if (!row) throw new Error("Missing row");
  const preview: PreviewSummary = {
    id: "pending-preview",
    repository: row.repository,
    worktree: `${row.repository}/${row.branch}`,
    relativePath: "page.html",
    kind: "html",
    network: false,
  };
  let previews: readonly PreviewSummary[] = [];
  const screen = render(
    <Board
      source={{
        ...data,
        previews: {
          getSnapshot: () => previews,
          pick: () => Promise.resolve(preview.id),
          close: () => Promise.resolve(),
          bounds: () => Promise.resolve(),
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.branch}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Preview file…" }));
  await act(async () => {});
  expect(localStorage.getItem(TILE_STORAGE)).toContain(preview.id);
  act(() => {
    previews = [preview];
    data.update(row.id, { seen: true });
  });
  expect(screen.getByRole("region", { name: "Tile 1: page.html" })).toBeTruthy();
});
