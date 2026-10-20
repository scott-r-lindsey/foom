import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { Sidebar } from "../../../../src/renderer/board/sidebar-view";
import type { SidebarRepository } from "../../../../src/renderer/board/sidebar.d";
import { boardRows as sampleRows } from "../../../fixtures/board";
import { installation } from "../../../fixtures/setup";
export const repository: SidebarRepository = {
  path: "/foom",
  name: "Foom",
  worktrees: [
    {
      path: "/foom",
      branch: "main",
      managed: false,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    },
    {
      path: "/tree",
      branch: "feature",
      managed: false,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    },
  ],
};

export const load = () =>
  Promise.resolve({
    repositories: [repository],
    agents: [
      installation("claude"),
      { ...installation("codex"), path: null },
      { ...installation("agy"), path: "/agy" },
    ],
    enabled: { claude: true, codex: true, agy: false },
    hooks: true,
  });

export function setup(mainCheckout = false) {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const base = createSampleSource([
    {
      ...original,
      id: "a",
      repository: "Foom",
      repositoryPath: "/foom",
      worktree: mainCheckout ? "/foom" : "/tree",
      branch: mainCheckout ? "main" : "feature",
      kind: "agent",
      agent: "claude",
      managed: true,
      bypass: true,
      exited: false,
    },
  ]);
  const command = vi.fn(() => Promise.resolve());
  const add = vi.fn(() => Promise.resolve(null));
  let listed: SidebarRepository[] = [repository];
  const branches = vi.fn((_repository: string) =>
    Promise.resolve({
      head: "main",
      local: [
        { name: "main", worktree: "/foom" },
        { name: "feature", worktree: "/tree" },
        { name: "codex/old", worktree: null },
      ],
      remote: "origin",
      remoteBranches: ["codex/remote"],
    }),
  );
  const create = vi.fn(async (_repository: string, branch: string) => {
    await Promise.resolve();
    const existing = repository.worktrees.find((tree) => tree.branch === branch);
    if (existing) return { ...existing, outcome: "open" as const };
    const tree = {
      path: `/trees/${branch}`,
      branch,
      managed: true,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    };
    listed = [{ ...repository, worktrees: [...repository.worktrees, tree] }];
    return { ...tree, outcome: "new" as const };
  });
  const source: BoardSource = {
    ...base,
    getSidebar: () => listed,
    shellName: () => "zsh",
    sidebarCommand: command,
    worktrees: {
      load,
      addRepository: add,
      branches,
      create,
      remove: () => Promise.resolve(true),
    },
  };
  const view = render(<Board source={source} />);
  return { ...view, base, source, command, add, branches, create };
}

export async function emptySections(rows: readonly BoardRow[] = []) {
  const source: BoardSource = {
    ...createSampleSource(rows),
    getSidebar: () => [repository, { name: "Empty repo", path: "/empty", worktrees: [] }],
    config: {
      status: () =>
        Promise.resolve({
          folder: "/config",
          available: true,
          pending: null,
          rejected: [],
        }),
      subscribe: () => () => {},
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

export function sidebarWithSessions(narrow: boolean) {
  vi.stubGlobal("matchMedia", () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const rows = [
    { ...original, repository: "Zulu", repositoryPath: "/zulu", worktree: "/zulu", branch: "main" },
  ];
  const repositories = ["Alpha", "Zulu"].map((name) => ({
    name,
    path: `/${name.toLowerCase()}`,
    worktrees: [
      {
        path: `/${name.toLowerCase()}`,
        branch: "main",
        head: "abc",
        managed: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
  }));
  const branches = vi.fn(() =>
    Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
  );
  const source: BoardSource = {
    ...createSampleSource(rows),
    getSidebar: () => repositories,
    worktrees: {
      load: () => new Promise(() => {}),
      branches,
      create: vi.fn(),
      remove: vi.fn(),
      addRepository: vi.fn(),
    },
  };
  const ref: { current: ((repository?: string) => boolean) | undefined } = { current: undefined };
  const view = render(
    <Sidebar
      source={source}
      inactive={false}
      revealRef={{ current: undefined }}
      rows={rows}
      preferences={{ pins: [], expanded: {}, names: {} }}
      save={() => {}}
      selected={undefined}
      buttons={{ current: new Map() }}
      sidebar={{ current: null }}
      open={() => {}}
      focus={() => {}}
      newWorktreeRef={ref}
      command={() => Promise.resolve()}
      options={undefined}
      footer={null}
    />,
  );
  return { ...view, ref, branches };
}
