import { expect, test } from "vitest";
import {
  restoreAuthority,
  restorePlan,
  runRestore,
} from "../../../../src/main/workspace/session-restore";
import type { StoredSession } from "../../../../src/main/workspace/session-restore.d";
const row: StoredSession = {
  id: "agent",
  agent: "claude",
  kind: "agent",
  repository: "/repo",
  worktree: "/repo",
  branch: "main",
  attention: "evaluator",
  state: null,
  running: true,
  conversationId: "conversation",
};

test("plans only previously running shells and agents with conversations, including Antigravity", () => {
  const legacy = { ...row };
  delete legacy.running;
  const withoutId = { ...row };
  delete withoutId.conversationId;
  const entries: StoredSession[] = [
    row,
    { ...row, id: "codex", agent: "codex" },
    { ...row, id: "agy", agent: "agy" },
    { ...row, id: "shell", agent: "shell", kind: "shell" },
    { ...row, id: "exited", running: false },
    { ...legacy, id: "legacy" },
    { ...withoutId, id: "no-id" },
  ];
  expect(restorePlan(entries, true).map((entry) => entry.id)).toEqual([
    "agent",
    "codex",
    "agy",
    "shell",
  ]);
  expect(restorePlan(entries, false)).toEqual([]);
});

test("authority requires the main-owned running grant, repository identity and a verified supported CLI", () => {
  const parent = { ...row, orchestrator: { identity: "identity", history: [] } };
  const agent = {
    id: "claude" as const,
    path: "/bin/claude",
    version: "2.1.300",
    hooks: true,
    mcp: true,
    reason: "",
  };
  expect(restoreAuthority(parent, "identity", agent, true)).toBe(true);
  expect(restoreAuthority(parent, "identity", { ...agent, id: "codex" }, true)).toBe(true);
  for (const entry of [row, { ...parent, running: false }])
    expect(restoreAuthority(entry, "identity", agent, true)).toBe(false);
  for (const identity of [undefined, "replacement"])
    expect(restoreAuthority(parent, identity, agent, true)).toBe(false);
  for (const cli of [
    undefined,
    { ...agent, path: null },
    { ...agent, mcp: false },
    { ...agent, id: "agy" as const },
  ])
    expect(restoreAuthority(parent, "identity", cli, true)).toBe(false);
  expect(restoreAuthority(parent, "identity", agent, false)).toBe(false);
});

test("caps launches at three, serializes shared checkouts, and finishes parents first", async () => {
  const parents = Array.from({ length: 4 }, (_, i) => ({
    ...row,
    id: `p${String(i)}`,
    worktree: `/p${String(i)}`,
    orchestrator: { identity: "identity", history: [] },
  }));
  const children = Array.from({ length: 7 }, (_, i) => ({
    ...row,
    id: `c${String(i)}`,
    worktree: `/c${String(i % 4)}`,
    parentId: "p0",
  }));
  let active = 0;
  let maximum = 0;
  let finishedParents = 0;
  const paths = new Set<string>();
  await runRestore([...children, ...parents], async (entry) => {
    expect(paths.has(entry.worktree)).toBe(false);
    paths.add(entry.worktree);
    maximum = Math.max(maximum, ++active);
    if (entry.parentId) expect(finishedParents).toBe(4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (entry.orchestrator) finishedParents++;
    active--;
    paths.delete(entry.worktree);
  });
  expect(maximum).toBe(3);
  expect(paths.size).toBe(0);
  await runRestore([], () => {
    throw new Error("unexpected");
  });
});

test("v2 restore capability requires the persisted human grant and verified installation", () => {
  const parent = {
    ...row,
    agent: "fixture-v2",
    providerOrigin: "config" as const,
    orchestrator: { identity: "identity", history: [] },
  };
  const installation = {
    id: "fixture-v2",
    path: "/fake/fixture-v2",
    version: "fixture 1.2.3",
    hooks: false,
    mcp: true,
    restoreControl: true,
    reason: "Approved",
  };
  expect(restoreAuthority(parent, "identity", installation, true)).toBe(true);
  expect(restoreAuthority(parent, "different", installation, true)).toBe(false);
  expect(restoreAuthority({ ...row, agent: "fixture-v2" }, "identity", installation, true)).toBe(
    false,
  );
  expect(
    restoreAuthority(parent, "identity", { ...installation, restoreControl: false }, true),
  ).toBe(false);
  expect(restoreAuthority(parent, "identity", { ...installation, mcp: false }, true)).toBe(false);
});
