// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Board } from "../../../../src/renderer/board/board-view";
import type { PreviewApi } from "../../../../src/shared/previews";
import type { PreviewSummary, SidebarInventory } from "../../../../src/shared/workspace";
import { agent, mock, settle } from "./app-board-fixture";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";

const preview: PreviewSummary = {
  id: "d".repeat(32),
  repository: "/code/app",
  worktree: "/code/app",
  relativePath: "picked.md",
  kind: "markdown",
  network: false,
};
const base: SidebarInventory = {
  shell: "bash",
  repositories: [
    {
      path: "/code/app",
      name: "app",
      worktrees: [
        {
          path: "/code/app",
          branch: "main",
          head: "abc",
          bare: false,
          locked: false,
          prunable: false,
          managed: false,
        },
      ],
    },
  ],
  previews: [],
};
const withPreview: SidebarInventory = { ...base, previews: [preview] };
const named = (name: string): SidebarInventory => ({
  ...base,
  repositories: base.repositories.map((repository) => ({ ...repository, name })),
});
const closePreview = vi.fn(async () => {});
let place: Parameters<NonNullable<PreviewApi["onPlace"]>>[0] | undefined;

beforeEach(() => {
  place = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  mock.sidebarInventory.mockResolvedValue(base);
  window.desktop.previews = {
    describe: vi.fn(() => Promise.resolve({ ...preview, repository: "" })),
    pick: vi.fn(() => Promise.resolve(preview.id)),
    onPlace: (callback) => {
      place = callback;
      return () => {};
    },
    reload: vi.fn(),
    network: vi.fn(),
    popout: vi.fn(),
    close: closePreview,
    bounds: vi.fn(async () => {}),
    painted: vi.fn(),
    cover: vi.fn(),
    onSnapshots: vi.fn(() => () => {}),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("picker publishes its ID while a newer inventory read is still pending", async () => {
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const own = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(own.promise).mockReturnValueOnce(newer.promise);
  const picked = source.previews?.pick(preview.worktree);
  await settle();
  mock.changed?.();
  await settle();
  own.resolve(withPreview);
  try {
    await expect(picked).resolves.toBe(preview.id);
    expect(source.previews?.getSnapshot()).toContainEqual(preview);
    newer.resolve(base);
    await settle();
    expect(source.previews?.getSnapshot()).toContainEqual(preview);
  } finally {
    newer.resolve(withPreview);
    await settle();
    off?.();
  }
});

test("a picked tile survives overlapping reads and a later workspace row update", async () => {
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [{ ...agent("a"), worktree: "/code/app" }],
  });
  window.desktop.panelFacts = () => new Promise(() => {});
  const source = createAppSource();
  const view = render(<Board source={source} />);
  await settle();
  const own = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  const last = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory
    .mockReturnValueOnce(own.promise)
    .mockReturnValueOnce(newer.promise)
    .mockReturnValueOnce(last.promise);
  try {
    fireEvent.click(view.getByRole("button", { name: "Actions for Main checkout" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Preview file…" }));
    await settle();
    act(() => {
      mock.changed?.();
    });
    await settle();
    own.resolve(withPreview);
    await settle();
    act(() => {
      mock.changed?.();
    });
    await settle();
    newer.resolve(withPreview);
    last.resolve(withPreview);
    await settle();
    expect(view.container.querySelectorAll('[data-preview-id="' + preview.id + '"]')).toHaveLength(
      1,
    );
    expect(source.previews?.getSnapshot()).toContainEqual(preview);
    expect(closePreview).not.toHaveBeenCalled();
    expect(view.queryByRole("alertdialog")).toBeNull();
  } finally {
    own.resolve(withPreview);
    newer.resolve(withPreview);
    last.resolve(withPreview);
    await settle();
    view.unmount();
  }
});

test.each(["available", "unavailable", "mismatched"])(
  "a discarded picker read never returns an unpublished ID (description: %s)",
  async (description) => {
    const api = window.desktop.previews;
    if (!api) throw new Error("Missing preview bridge");
    if (description === "unavailable") delete api.describe;
    if (description === "mismatched")
      api.describe = vi.fn(() => Promise.resolve({ ...preview, id: "e".repeat(32) }));
    const source = createAppSource();
    const off = source.connect?.();
    await settle();
    const own = Promise.withResolvers<SidebarInventory>();
    const newer = Promise.withResolvers<SidebarInventory>();
    mock.sidebarInventory.mockReturnValueOnce(own.promise).mockReturnValueOnce(newer.promise);
    const picked = source.previews?.pick(preview.worktree);
    await settle();
    mock.changed?.();
    await settle();
    newer.resolve(base);
    await settle();
    own.resolve(withPreview);
    try {
      const id = await picked;
      expect(id).toBe(description === "available" ? preview.id : null);
      if (id) expect(source.previews?.getSnapshot().some((entry) => entry.id === id)).toBe(true);
    } finally {
      off?.();
    }
  },
);

test("a picker read still publishes sidebar recovery when its record is unavailable", async () => {
  const api = window.desktop.previews;
  if (!api) throw new Error("Missing preview bridge");
  delete api.describe;
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const listener = vi.fn();
  source.subscribe(listener);
  mock.sidebarInventory.mockResolvedValueOnce(named("Recovered"));
  await expect(source.previews?.pick(preview.worktree)).resolves.toBeNull();
  expect(source.getSidebar?.()[0]?.name).toBe("Recovered");
  expect(listener).toHaveBeenCalled();
  off?.();
});

test("a superseded picker read refreshes owned facts even if a newer inventory included its ID", async () => {
  const api = window.desktop.previews;
  if (!api) throw new Error("Missing preview bridge");
  api.describe = vi.fn(() => Promise.resolve({ ...preview, network: true }));
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const own = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(own.promise).mockReturnValueOnce(newer.promise);
  const picked = source.previews?.pick(preview.worktree);
  await settle();
  mock.changed?.();
  await settle();
  newer.resolve(withPreview);
  await settle();
  own.resolve(base);
  await expect(picked).resolves.toBe(preview.id);
  expect(source.previews?.getSnapshot()).toContainEqual({ ...preview, network: true });
  off?.();
});

test.each(["pending", "failed"])(
  "startup applies a successful read when a newer human read is %s",
  async (state) => {
    const first = Promise.withResolvers<SidebarInventory>();
    const newer = Promise.withResolvers<SidebarInventory>();
    mock.sidebarInventory.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise);
    const source = createAppSource();
    const off = source.connect?.();
    await settle();
    const command = source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "a" });
    await settle();
    if (state === "failed") {
      const rejected = expect(command).rejects.toThrow("read failed");
      newer.reject(new Error("read failed"));
      await rejected;
    }
    first.resolve(named("Recovered"));
    await settle();
    try {
      expect(source.isSidebarReady?.()).toBe(true);
      expect(source.getSidebar?.()[0]?.name).toBe("Recovered");
    } finally {
      newer.resolve(base);
      if (state === "pending") await command;
      off?.();
    }
  },
);

test("a newer background read does not discard an older successful startup read", async () => {
  const first = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise);
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  mock.changed?.();
  await settle();
  first.resolve(named("Recovered"));
  await settle();
  try {
    expect(source.isSidebarReady?.()).toBe(true);
    expect(source.getSidebar?.()[0]?.name).toBe("Recovered");
  } finally {
    newer.resolve(base);
    await settle();
    off?.();
  }
});

test("an older reply cannot replace a newer successful inventory already applied", async () => {
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const older = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const command = source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "a" });
  await settle();
  mock.changed?.();
  await settle();
  newer.resolve(named("Newest"));
  await settle();
  older.resolve(named("Older"));
  await command;
  expect(source.getSidebar?.()[0]?.name).toBe("Newest");
  off?.();
});

test.each([false, true])(
  "human recovery clears the sidebar error (overlapping background success: %s)",
  async (overlap) => {
    mock.sidebarInventory.mockRejectedValueOnce(new Error("offline"));
    const marks = new Set<string>();
    const source = createAppSource();
    const off = source.connect?.({
      report: (operation) => {
        marks.add(operation);
      },
      clear: (operation) => {
        marks.delete(operation);
      },
    });
    await settle();
    expect(marks.has("sidebar-refresh")).toBe(true);
    const background = Promise.withResolvers<SidebarInventory>();
    const human = Promise.withResolvers<SidebarInventory>();
    if (overlap) {
      mock.sidebarInventory.mockReturnValueOnce(background.promise);
      mock.changed?.();
      await settle();
    }
    mock.sidebarInventory.mockReturnValueOnce(human.promise);
    const command = source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "a" });
    await settle();
    background.resolve(base);
    await settle();
    human.resolve(base);
    await command;
    await settle();
    expect(source.isSidebarReady?.()).toBe(true);
    expect(marks.has("sidebar-refresh")).toBe(false);
    off?.();
  },
);

test("older good inventory still publishes facts while retaining a locally placed preview", async () => {
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  source.previews?.onPlace?.(() => Promise.resolve("empty"));
  const older = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const command = source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "a" });
  await settle();
  mock.changed?.();
  await settle();
  const placement = place;
  if (!placement) throw new Error("Missing placement subscription");
  await placement(preview.id, Date.now() + 5000);
  older.resolve(named("Recovered"));
  await command;
  try {
    expect(source.getSidebar?.()[0]?.name).toBe("Recovered");
    expect(source.previews?.getSnapshot().some((entry) => entry.id === preview.id)).toBe(true);
  } finally {
    newer.resolve(withPreview);
    await settle();
    off?.();
  }
});

test("only a successful read begun after publication can remove a locally placed preview", async () => {
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  source.previews?.onPlace?.(() => Promise.resolve("empty"));
  const older = Promise.withResolvers<SidebarInventory>();
  const newer = Promise.withResolvers<SidebarInventory>();
  mock.sidebarInventory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const command = source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "a" });
  await settle();
  mock.changed?.();
  await settle();
  const placement = place;
  if (!placement) throw new Error("Missing placement subscription");
  await placement(preview.id, Date.now() + 5000);
  older.resolve(withPreview);
  await command;
  newer.resolve(base);
  await settle();
  try {
    expect(source.previews?.getSnapshot().some((entry) => entry.id === preview.id)).toBe(true);
    mock.changed?.();
    await settle();
    expect(source.previews?.getSnapshot()).toEqual([]);
  } finally {
    off?.();
  }
});
