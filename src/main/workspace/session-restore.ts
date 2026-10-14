import { builtinAgent } from "../../shared/providers/catalog";
import type { StoredSession } from "./session-restore.d";
import type { AgentInstallation } from "../../shared/agents";

export function restorePlan(entries: readonly StoredSession[], enabled: boolean): StoredSession[] {
  return enabled
    ? entries.filter(
        (entry) =>
          entry.running === true && (entry.agent === "shell" || entry.conversationId !== undefined),
      )
    : [];
}

export function restoreAuthority(
  entry: StoredSession,
  identity: string | undefined,
  agent: AgentInstallation | undefined,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    entry.running === true &&
    entry.orchestrator !== undefined &&
    entry.orchestrator.identity === identity &&
    agent?.path !== null &&
    agent?.mcp === true &&
    (agent.restoreControl ?? builtinAgent(agent.id)?.restoreControl) === true
  );
}

/** Three launches at a time. Parents finish before any child can be started. */
export async function runRestore(
  entries: readonly StoredSession[],
  launch: (entry: StoredSession) => Promise<void>,
): Promise<void> {
  const parents = entries.filter((entry) => entry.orchestrator !== undefined);
  const rest = entries.filter((entry) => entry.orchestrator === undefined);
  const paths = new Map<string, Promise<void>>();
  for (const group of [parents, rest]) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, group.length) }, async () => {
        while (next < group.length) {
          const entry = group[next++];
          if (entry) {
            const previous = paths.get(entry.worktree) ?? Promise.resolve();
            const work = previous.then(() => launch(entry));
            paths.set(entry.worktree, work);
            await work;
          }
        }
      }),
    );
  }
}
