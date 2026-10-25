import { randomUUID } from "node:crypto";
import type { AgentLaunch, AgentLaunched, HookHealthState } from "../../shared/agents";
import type { HookSignal } from "../../shared/hooks";
import type { V2HookRuntime } from "../../shared/v2-hooks";
import type { TerminalSpec } from "../../shared/desktop";
import type { RemoteAgentReady } from "../../shared/remote-agent";
import type { ControlLaunch } from "../control/types";
import type { remoteAgentTarget } from "../terminals/remote-bootstrap";
import { agentProvider } from "./providers/registry";
import { V2ExecutionHooks } from "./providers/v2-health";

export interface RemoteHooks {
  bind: (key: string, id: string, runtime: V2HookRuntime) => void;
  signal: (signal: HookSignal) => void | Promise<void>;
  revoke: (key: string) => void;
}
/** A remote launch keeps all hub credentials and terminal identities in main. */
export async function launchRemoteChild(
  request: AgentLaunch,
  mapping: NonNullable<ReturnType<typeof remoteAgentTarget>>,
  defaults: readonly string[],
  hooks: boolean,
  terminals: { create(spec: TerminalSpec): string | Promise<string> },
  control: ControlLaunch,
  validate: () => Promise<void>,
  observer?: RemoteHooks,
): Promise<{ result: AgentLaunched; dispose(): void }> {
  if (!request.control || !("parentId" in request.control) || !control.remoteCall)
    throw new Error("Remote phase 2 requires a local-orchestrator-owned child");
  const provider = agentProvider(request.agent);
  if (provider.origin !== "bundled") throw new Error("Remote phase 2 requires a bundled agent");
  const id = request.terminalId ?? randomUUID();
  const key = randomUUID();
  let ready: RemoteAgentReady | undefined;
  let health: HookHealthState = "not-reviewed";
  const channels = new Map<string, unknown>();
  const runtime = new V2ExecutionHooks(provider.model, channels, {
    get: () => health,
    begin: () => 1,
    set: (state) => {
      health = state;
    },
    flush: () => Promise.resolve(),
  });
  let active = true;
  const live = () => active;
  let bound = false;
  let authorized = false;
  const pending: HookSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let conversation = request.conversationId;
  const dispose = () => {
    if (!live()) return;
    active = false;
    clearTimeout(timer);
    pending.length = 0;
    observer?.revoke(key);
    control.dispose();
  };
  try {
    await validate();
    const serialized = JSON.stringify({
      repository: mapping.repository,
      worktree: mapping.worktree,
      defaults,
      prompt: request.prompt,
      conversationId: request.conversationId,
    });
    if ([id, request.control.parentId].some((secret) => serialized.includes(secret)))
      throw new Error("Remote launch data contains a hub terminal identity");
    const spec: TerminalSpec = {
      id,
      command: `ssh ${mapping.target.host}`,
      args: [],
      cwd: request.worktree,
      cols: request.cols,
      rows: request.rows,
      env: {},
      remote: {
        ...mapping.target,
        agent: {
          spec: {
            agent: request.agent,
            repository: mapping.repository,
            worktree: mapping.worktree,
            defaults: [...defaults],
            hooks,
            ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
            ...(request.conversationId === undefined
              ? {}
              : { conversationId: request.conversationId }),
          },
          authorize: async () => {
            if (!live() || authorized) throw new Error("Remote launch unavailable");
            await validate();
            if (!live()) throw new Error("Remote launch revoked");
            request.beforeSpawn?.();
            authorized = true;
          },
          call: (method, params) =>
            active && bound && control.remoteCall
              ? control.remoteCall(method, params)
              : Promise.resolve({ type: "error", error: "unavailable" }),
          ready: (value) => {
            if (!live()) return;
            if (!authorized) throw new Error("Remote launch was not authorized");
            if (conversation && value.conversationId && conversation !== value.conversationId)
              throw new Error("Remote conversation changed");
            if ((!hooks && value.hooks) || value.hooks !== Boolean(value.channels?.length))
              throw new Error("Invalid remote hook selection");
            ready = value;
            conversation ??= value.conversationId;
            channels.clear();
            for (const channel of value.channels ?? []) {
              if (!provider.model.hooks?.channels.some((entry) => entry.id === channel))
                throw new Error("Foreign remote channel");
              channels.set(channel, true);
            }
          },
          hook: (signal) => {
            if (!live()) return;
            const channel = provider.model.hooks?.channels.find(
              (entry) => entry.id === signal.channel,
            );
            const entry = channel?.mapping.cases.find((entry) => entry.id === signal.caseId);
            if (
              !hooks ||
              !channels.has(signal.channel ?? "") ||
              !entry ||
              signal.action !== entry.action ||
              signal.signal !== `plugin:${request.agent}:${entry.id}` ||
              signal.endsTurn !==
                (entry.endsTurn ?? (entry.action === "classify" || entry.action === "failed")) ||
              signal.recoverTurn !== entry.recoverTurn ||
              (conversation !== undefined && conversation !== signal.conversationId)
            )
              throw new Error("Invalid remote hook");
            conversation ??= signal.conversationId;
            const reduced = { ...signal, terminalId: key };
            if (bound) return observer?.signal(reduced);
            else {
              if (pending.length >= 64) throw new Error("Remote hook backlog exceeded");
              pending.push(reduced);
            }
          },
        },
      },
    };
    const created = await terminals.create(spec);
    if (created !== id || !ready) throw new Error("Remote launch was not acknowledged");
    control.bind(id, ready.mcp);
    bound = true;
    spec.remote?.agent?.activate?.();
    if (ready.hooks) observer?.bind(key, id, runtime);
    timer = setTimeout(() => {
      if (live())
        for (const signal of pending.splice(0))
          void Promise.resolve(observer?.signal(signal)).catch(() => {
            dispose();
          });
    }, 0);
    return {
      result: {
        id,
        remote: true,
        providerOrigin: "bundled",
        attention: ready.hooks ? "hooks" : "evaluator",
        ...(conversation ? { conversationId: conversation } : {}),
        bypass: false,
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
