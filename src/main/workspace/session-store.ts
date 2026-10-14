import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { conversationId } from "../agents/conversation";
import { WORKTREE_LIMIT } from "../control/orchestration";
import type { OwnedWorktree, StoredSession } from "./session-restore.d";
import type { OrchestrationEntry } from "../../shared/workspace";

function path(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 4096 && isAbsolute(value) && !value.includes("\0")
  );
}

/** Validated main-owned metadata; executable paths and credentials are never stored. */
export function readSessions(value: unknown): StoredSession[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid sessions");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Invalid session");
    const data: Record<string, unknown> = { ...entry };
    const {
      id,
      agent,
      repository,
      worktree,
      branch,
      conversationId: conversation,
      home,
      config,
      running,
      orchestrator,
      parentId,
    } = data;
    if (
      (home !== undefined &&
        (home !== true || agent !== "shell" || repository !== worktree || branch !== null)) ||
      (config !== undefined &&
        (config !== true || home !== undefined || repository !== worktree || branch !== null)) ||
      (running !== undefined && typeof running !== "boolean") ||
      (parentId !== undefined &&
        (!conversationId(parentId) || parentId === id || agent === "shell")) ||
      !conversationId(id) ||
      ids.has(id) ||
      !path(repository) ||
      !path(worktree) ||
      !(
        branch === null ||
        (typeof branch === "string" && branch.length <= 4096 && !/\p{Cc}/u.test(branch))
      ) ||
      (conversation !== undefined &&
        (!conversationId(conversation) ||
          (agent !== "claude" && agent !== "codex" && agent !== "agy")))
    )
      throw new Error("Invalid session");
    if (agent !== "claude" && agent !== "codex" && agent !== "agy" && agent !== "shell")
      throw new Error("Invalid agent");
    const role = readOrchestrator(orchestrator);
    if (role && (parentId !== undefined || agent === "shell" || home || config))
      throw new Error("Invalid role");
    ids.add(id);
    return {
      id,
      ...(running === undefined ? {} : { running }),
      ...(role === undefined ? {} : { orchestrator: role }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(home === true ? { home: true } : {}),
      ...(config === true ? { config: true } : {}),
      agent,
      repository,
      worktree,
      branch,
      kind: agent === "shell" ? "shell" : "agent",
      attention: "evaluator",
      state: null,
      exited: true,
      dormant: true,
      ...(conversation === undefined ? {} : { conversationId: conversation }),
    };
  });
}

export class SessionStore {
  private pending = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<StoredSession[]> {
    try {
      const contents = await readFile(join(this.directory, "sessions.json"), "utf8");
      if (contents.length > 1024 * 1024) return [];
      const value: unknown = JSON.parse(contents);
      return readSessions(value);
    } catch {
      return [];
    }
  }
  save(entries: readonly StoredSession[]): Promise<void> {
    const data = JSON.stringify(
      entries.map(
        ({
          id,
          agent,
          repository,
          worktree,
          branch,
          conversationId,
          home,
          config,
          running,
          orchestrator,
          parentId,
        }) => ({
          running,
          orchestrator,
          parentId,
          ...(home ? { home: true } : {}),
          ...(config ? { config: true } : {}),
          id,
          agent,
          repository,
          worktree,
          branch,
          conversationId,
        }),
      ),
    );
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        const temporary = join(this.directory, "sessions.json.tmp");
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, join(this.directory, "sessions.json"));
      });
    this.pending = next;
    return next;
  }
  flush(): Promise<void> {
    return this.pending;
  }
}

function readOrchestrator(value: unknown): StoredSession["orchestrator"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new Error("Invalid role");
  const data: Record<string, unknown> = { ...value };
  if (
    typeof data["identity"] !== "string" ||
    !data["identity"] ||
    data["identity"].length > 4096 ||
    !Array.isArray(data["history"]) ||
    data["history"].length > 20
  )
    throw new Error("Invalid role");
  const history: OrchestrationEntry[] = data["history"].map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("Invalid history");
    const row: Record<string, unknown> = { ...item };
    const { id, action, label, status, at } = row;
    if (
      typeof id !== "string" ||
      id.length > 256 ||
      typeof label !== "string" ||
      label.length > 4096 ||
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      (action !== "create_worktree" &&
        action !== "launch" &&
        action !== "stop" &&
        action !== "close" &&
        action !== "remove_worktree" &&
        action !== "reply" &&
        action !== "take_over") ||
      (status !== "pending_confirmation" &&
        status !== "running" &&
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "declined" &&
        status !== "cancelled" &&
        status !== "indeterminate")
    )
      throw new Error("Invalid history");
    return { id, action, label, status, at };
  });
  const worktrees = data["worktrees"];
  const uncertain = data["uncertain"];
  if (
    uncertain !== undefined &&
    (typeof uncertain !== "number" ||
      !Number.isInteger(uncertain) ||
      uncertain < 0 ||
      uncertain > WORKTREE_LIMIT)
  )
    throw new Error("Invalid worktree budget");
  let owned: OwnedWorktree[] | undefined;
  if (worktrees !== undefined) {
    if (!Array.isArray(worktrees) || worktrees.length > 1000) throw new Error("Invalid worktrees");
    const paths = new Set<string>();
    owned = worktrees.map((item: unknown) => {
      if (typeof item !== "object" || item === null) throw new Error("Invalid worktree");
      const row: Record<string, unknown> = { ...item };
      const { path: checkout, identity, state } = row;
      if (
        Object.keys(row).some((key) => !["path", "identity", "state"].includes(key)) ||
        !path(checkout) ||
        paths.has(checkout) ||
        typeof identity !== "string" ||
        !identity ||
        identity.length > 4096 ||
        (state !== "unused" && state !== "used")
      )
        throw new Error("Invalid worktree");
      paths.add(checkout);
      return { path: checkout, identity, state };
    });
    if (
      owned.filter((tree) => tree.state === "unused").length +
        (typeof uncertain === "number" ? uncertain : 0) >
      WORKTREE_LIMIT
    )
      throw new Error("Invalid worktree budget");
  }
  return {
    identity: data["identity"],
    history,
    ...(owned === undefined ? {} : { worktrees: owned }),
    ...(typeof uncertain === "number" ? { uncertain } : {}),
  };
}
