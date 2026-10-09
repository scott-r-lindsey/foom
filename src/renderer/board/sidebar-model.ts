import type { BoardRow, BoardState } from "./board.d";
import type { SidebarPreferences, SidebarRepository, SidebarTree } from "./sidebar.d";

const ranks: Record<BoardState, number> = {
  needs_input: 5,
  failed: 4,
  working: 3,
  done: 2,
  quiet_ok: 1,
};
export const agentNames: ReadonlyMap<string, string> = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["agy", "Antigravity"],
  ["shell", "Shell"],
]);
export const agentBadges: ReadonlyMap<string, string> = new Map([
  ["claude", "CC"],
  ["Claude Code", "CC"],
  ["codex", "CX"],
  ["Codex", "CX"],
  ["agy", "AG"],
  ["Antigravity", "AG"],
  ["shell", ">_"],
  ["Shell", ">_"],
]);
/** Keep identity independent of the editable session name. */
export function sessionIdentity(row: BoardRow, shell: string | undefined): string {
  if (row.kind === "shell" || row.agent === "shell" || row.agent === "Shell")
    return shell ? `Shell (${shell})` : "Shell";
  return agentNames.get(row.agent) || row.agent || "Unknown agent";
}
export function sessionName(row: BoardRow, preferences: SidebarPreferences): string {
  return preferences.names[row.id] || agentNames.get(row.agent) || row.agent;
}
export function rollup(rows: readonly BoardRow[]): BoardRow | undefined {
  return rows.reduce<BoardRow | undefined>(
    (best, row) => (!best || ranks[row.state] > ranks[best.state] ? row : best),
    undefined,
  );
}
export function repositoryKey(path: string): string {
  return `repository:${path}`;
}
export function worktreeKey(path: string): string {
  return `worktree:${path}`;
}
export function rowRepository(row: BoardRow): string {
  return row.repositoryPath ?? row.repository;
}
export function rowWorktree(row: BoardRow): string {
  return row.worktree ?? `${rowRepository(row)}/${row.branch}`;
}
/** Retain locations with sessions even when Git no longer lists their checkout. */
export function sidebarRepositories(
  rows: readonly BoardRow[],
  registered: readonly SidebarRepository[],
): SidebarRepository[] {
  const result = new Map(registered.map((repo) => [repo.path, repo]));
  for (const row of rows) {
    const path = rowRepository(row);
    const repo = result.get(path) ?? { path, name: row.repository, worktrees: [] };
    if (!repo.worktrees.some((tree) => tree.path === rowWorktree(row))) {
      result.set(path, {
        ...repo,
        worktrees: [
          ...repo.worktrees,
          {
            path: rowWorktree(row),
            branch: row.branch,
            head: null,
            bare: false,
            locked: false,
            prunable: false,
            managed: Boolean(row.managed),
            removed: row.worktreeRemoved === true,
          },
        ],
      });
    } else result.set(path, repo);
  }
  return [...result.values()];
}
export function buildSidebar(
  rows: readonly BoardRow[],
  repositories: readonly SidebarRepository[],
  preferences: SidebarPreferences,
  filter: string,
): { tree: SidebarTree[]; hiddenNeeds: number } {
  const query = filter.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
  const visible = new Set<string>();
  const single = repositories.length === 1;
  const tree: SidebarTree[] = [];
  for (const repository of repositories) {
    const sessions = rows.filter((row) => rowRepository(row) === repository.path);
    const pin = preferences.pins.indexOf(repository.path);
    const repoMatches = matches(repository.name);
    const worktrees: SidebarTree["worktrees"] = [];
    for (const item of repository.worktrees) {
      const all = sessions.filter((row) => rowWorktree(row) === item.path);
      const branchMatches =
        matches(item.branch ?? "Detached HEAD") ||
        (item.path === repository.path && matches("Main checkout"));
      const filtered = all.filter(
        (row) =>
          repoMatches ||
          branchMatches ||
          matches(sessionName(row, preferences)) ||
          matches(row.reason),
      );
      if (query && !repoMatches && !branchMatches && !filtered.length) continue;
      for (const row of filtered) visible.add(row.id);
      worktrees.push({
        tree: item,
        sessions: filtered,
        rollup: rollup(all),
        expanded: Boolean(query) || (preferences.expanded[worktreeKey(item.path)] ?? true),
      });
    }
    if (query && !repoMatches && !worktrees.length) continue;
    tree.push({
      repository,
      section: single ? 0 : pin >= 0 ? 0 : sessions.length ? 1 : 2,
      pinned: pin >= 0,
      rollup: rollup(sessions),
      worktrees,
      expanded:
        Boolean(query) ||
        (preferences.expanded[repositoryKey(repository.path)] ??
          (single || sessions.some((row) => !row.exited))),
    });
  }
  tree.sort(
    (a, b) =>
      a.section - b.section ||
      (a.pinned && b.pinned
        ? preferences.pins.indexOf(a.repository.path) - preferences.pins.indexOf(b.repository.path)
        : a.repository.name.localeCompare(b.repository.name, undefined, { sensitivity: "base" }) ||
          a.repository.path.localeCompare(b.repository.path)),
  );
  return {
    tree,
    hiddenNeeds: query
      ? rows.filter((row) => row.state === "needs_input" && !visible.has(row.id)).length
      : 0,
  };
}
