import { vi } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import type {
  AuthorizedChild,
  ReviewAuthority,
} from "../../../../src/main/control/orchestration-automation.d";
import type { Principal, StoredOperation } from "../../../../src/main/control/types";
import type { ReviewState } from "../../../../src/shared/review";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

/** Isolated effect capabilities: no workspace, service, or mutable authority stores. */
export function automationFixture() {
  const actor: Principal = {
    role: "orchestrator",
    terminalId: "parent",
    parentId: null,
    repository: "/repo",
    worktree: "/repo",
    generation: "generation",
    sessionId: "session",
    grantedAt: new Date(0).toISOString(),
  };
  const row: WorkspaceTerminal = {
    id: "author",
    kind: "agent",
    agent: "claude",
    repository: "/repo",
    worktree: "/repo/child",
    branch: "child",
    attention: "hooks",
    state: null,
    exited: true,
    conversationId: "conversation",
  };
  const state: ReviewState = {
    authorId: row.id,
    phase: "building",
    round: 1,
    rounds: 3,
    agent: "claude",
    postFindings: false,
  };
  const owned = {
    repository: "/repo",
    tree: { path: row.worktree, identity: "identity" },
    exited: vi.fn(() => true),
    active: vi.fn(() => true),
    valid: vi.fn(() => true),
    validate: vi.fn(),
    note: vi.fn(),
    closeScope: () => ({ signal: new AbortController().signal, release: () => {} }),
  } satisfies AuthorizedChild;
  const reservation = { release: vi.fn(), exited: vi.fn(), attach: vi.fn() };
  const authority = {
    authorize: vi.fn(() => owned),
    capacity: vi.fn(() => true),
    reserve: vi.fn<ReviewAuthority["reserve"]>(() => reservation),
    changed: vi.fn(),
    released: vi.fn(),
    resumed: vi.fn(),
  } satisfies ReviewAuthority;
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(persist, () => {});
  return { actor, row, state, owned, reservation, authority, persist, operations };
}

export const settleAutomation = () => new Promise<void>((resolve) => setImmediate(resolve));
