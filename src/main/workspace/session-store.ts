import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { conversationId } from "../agents/conversation";
import type { WorkspaceTerminal } from "../../shared/workspace";

function path(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 4096 && isAbsolute(value) && !value.includes("\0")
  );
}

/** Restore metadata only. Disk records never authorize executables or automatic launches. */
export function readSessions(value: unknown): WorkspaceTerminal[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid sessions");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Invalid session");
    const data: Record<string, unknown> = { ...entry };
    const { id, agent, repository, worktree, branch, conversationId: conversation } = data;
    if (
      !conversationId(id) ||
      ids.has(id) ||
      !path(repository) ||
      !path(worktree) ||
      !(
        branch === null ||
        (typeof branch === "string" && branch.length <= 4096 && !/\p{Cc}/u.test(branch))
      ) ||
      (conversation !== undefined &&
        (!conversationId(conversation) || (agent !== "claude" && agent !== "codex")))
    )
      throw new Error("Invalid session");
    if (agent !== "claude" && agent !== "codex" && agent !== "agy" && agent !== "shell")
      throw new Error("Invalid agent");
    if (
      data["readOnly"] !== undefined &&
      (typeof data["readOnly"] !== "boolean" || (agent !== "claude" && agent !== "codex"))
    )
      throw new Error("Invalid review mode");
    ids.add(id);
    return {
      id,
      ...(data["readOnly"] === true ? { readOnly: true } : {}),
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
  async load(): Promise<WorkspaceTerminal[]> {
    try {
      const contents = await readFile(join(this.directory, "sessions.json"), "utf8");
      if (contents.length > 1024 * 1024) return [];
      const value: unknown = JSON.parse(contents);
      return readSessions(value);
    } catch {
      return [];
    }
  }
  save(entries: readonly WorkspaceTerminal[]): Promise<void> {
    const data = JSON.stringify(
      entries.map(({ id, agent, repository, worktree, branch, conversationId, readOnly }) => ({
        id,
        agent,
        repository,
        worktree,
        branch,
        conversationId,
        readOnly,
      })),
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
