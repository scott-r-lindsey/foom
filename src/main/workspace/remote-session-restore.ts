import type { AgentLaunch, AgentLaunched } from "../../shared/agents";
import type { TerminalSpec } from "../../shared/desktop";
import type { StoredSession } from "./session-restore.d";
import type { Hosts } from "../setup/hosts";
import { builtinAgent } from "../../shared/providers/catalog";
import { homeDirectory } from "./home-shell";

/** Only this profile's daemon inventory is eligible; discovery never restores grants. */
export async function discoverRemoteSessions(
  hosts: Pick<Hosts, "registered"> & Partial<Pick<Hosts, "sessions" | "placement">>,
): Promise<StoredSession[]> {
  const sessions = (await hosts.sessions?.()) ?? [];
  return sessions.map(({ host, session }) => {
    const context = session.context;
    const placed = context && hosts.placement?.(context.worktree);
    const agent = placed && builtinAgent(context.agent) ? context.agent : "shell";
    return {
      id: session.id,
      agent,
      kind: agent === "shell" ? "shell" : "agent",
      repository: placed?.localRepository ?? homeDirectory,
      worktree: context && placed ? context.worktree : homeDirectory,
      branch: placed ? `${placed.branch} · ${host}` : null,
      ...(placed ? {} : { home: true }),
      ...(placed
        ? {
            remoteCheckout: {
              repository: placed.repository,
              path: placed.path,
              branch: placed.branch,
              identity: placed.identity,
            },
          }
        : {}),
      remote: true,
      placement: { kind: "remote", host },
      attention: "evaluator",
      state: null,
      exited: true,
      dormant: true,
      running: true,
      recovered: true,
    };
  });
}

export class RemoteSessionExit extends Error {
  constructor(readonly code: number) {
    super("Remote session exited");
  }
}

/** Reattach never creates a process, even when its recorded ID has disappeared. */
export async function reattachRemoteSession(
  entry: StoredSession,
  hosts: Pick<Hosts, "registered"> & Partial<Pick<Hosts, "sessions" | "placement">>,
  terminals: { create(spec: TerminalSpec): Promise<string> },
  launch: (request: AgentLaunch) => Promise<AgentLaunched>,
  control?: AgentLaunch["control"],
  guard: () => void = () => {},
): Promise<AgentLaunched> {
  const placement = entry.placement;
  if (placement?.kind !== "remote") throw new Error("Missing remote placement");
  hosts.registered(placement.host);
  let exitCode: number | undefined;
  const unavailable = (code: number) => {
    exitCode = code;
  };
  const checkout = hosts.placement?.(entry.worktree);
  const validate = () => {
    hosts.registered(placement.host);
    return Promise.resolve();
  };
  if (control && "parentId" in control && checkout) {
    try {
      return await launch({
        agent: entry.agent,
        repository: entry.repository,
        worktree: entry.worktree,
        terminalId: entry.id,
        cols: 80,
        rows: 24,
        reattach: true,
        defaultArguments: [],
        sharedCheckout: true,
        control,
        ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
        beforeSpawn: () => {
          guard();
          hosts.registered(placement.host);
        },
        remoteCheckout: {
          target: { host: placement.host, unavailable },
          repository: checkout.repository,
          worktree: checkout.path,
          identity: checkout.identity,
          branch: checkout.branch,
          validate,
        },
      });
    } catch (error) {
      if (exitCode !== undefined) throw new RemoteSessionExit(exitCode);
      throw error;
    }
  }
  // Missing/taken-over parents and recovered records get only human terminal access.
  try {
    await terminals.create({
      id: entry.id,
      command: `ssh ${placement.host}`,
      args: [],
      cwd: entry.worktree,
      cols: 80,
      rows: 24,
      env: {},
      remote: { host: placement.host, reattach: true, human: true, unavailable },
    });
  } catch (error) {
    if (exitCode !== undefined) throw new RemoteSessionExit(exitCode);
    throw error;
  }
  return { id: entry.id, remote: true, placement, attention: "evaluator", bypass: false };
}
