import { saveCapture, testCaptureRules } from "../../node-common/probe-captures";
import { agentProvider } from "./providers/registry";
import { ProbeAttention, PROBE_WAITING_MS } from "./probe-attention";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ProbeRequest } from "../../node-common/agent-probe";
import { PROBE_KEYS, probeRequest } from "../../node-common/agent-probe";
import { ControlError } from "../../node-common/control-validation";
import type { ConfigStatus } from "../../shared/foom-config";
import type { TerminalSpec } from "../../shared/desktop";
import type { AgentProvider } from "./providers/provider";
import { evaluateRules } from "../evaluator/evaluator";
import { prepareProbe, probeEnvironment, probeProvider, scratchRepository } from "./probe-launch";

type Probe = {
  id: string;
  terminal?: string;
  cwd?: string;
  provider?: AgentProvider;
  conversationId?: string | undefined;
  agentVersion?: string;
  dispose?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  cleaning?: Promise<void>;
  output: number;
  revision: number;
  changed: Set<() => void>;
};
export interface ProbeBackend {
  configStatus?(): Promise<ConfigStatus>;
  waitingChanged?(): void;
  create(spec: TerminalSpec): Promise<string>;
  stop(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  reply(id: string, data: string): Promise<void>;
  screen(id: string): Promise<{ lines: string[]; title: string; cols?: number; rows?: number }>;
  show(
    id: string,
    agent: string,
    conversationId: string | undefined,
    owner: string,
    cwd: string,
    assertActive: () => void,
  ): Promise<void>;
  removed(id: string): void;
}
/** Credentials own objects, never arbitrary terminal IDs. Reserve before the first await. */
export class AgentProbes {
  private readonly sessions = new Map<string, Probe | null>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly attention: ProbeAttention;
  constructor(
    private readonly backend: ProbeBackend,
    private readonly root: string,
    private readonly operations = {
      environment: probeEnvironment,
      scratch: scratchRepository,
      provider: probeProvider,
      prepare: prepareProbe,
    },
    private readonly limitMs = 600000,
    waitingMs = PROBE_WAITING_MS,
    now = Date.now,
  ) {
    this.attention = new ProbeAttention(() => backend.waitingChanged?.(), waitingMs, now);
  }
  waitingAt(owner: string): number | undefined {
    return this.attention.waitingAt(owner);
  }
  dismiss(owner: string): void {
    this.attention.dismiss(owner);
  }
  input(id: string): void {
    for (const probe of this.sessions.values())
      if (probe?.terminal === id) {
        probe.revision++;
        this.attention.input(id);
      }
  }
  async quiet(id: string): Promise<void> {
    for (const [owner, probe] of this.sessions)
      if (probe?.terminal === id && !probe.stopping) {
        const revision = probe.revision;
        const current = () =>
          this.sessions.get(owner) === probe && !probe.stopping && probe.revision === revision;
        const screen = await this.backend.screen(id);
        if (!current()) return;
        const verdict = evaluateRules(
          {
            terminalId: id,
            agent: probe.provider?.id ?? "",
            evidence: { title: screen.title, progress: null },
            tail: screen.lines,
          },
          probe.provider?.model.attention.rules.map(({ lines, ...rule }) => ({
            ...rule,
            ...(lines === undefined ? {} : { lines }),
          })),
        );
        this.attention.observe(id, verdict.state === "needs_input");
      }
  }
  grant(): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, null);
    return token;
  }
  async revoke(token: string): Promise<void> {
    const probe = this.sessions.get(token);
    this.sessions.delete(token);
    if (probe) await this.stop(probe);
  }
  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((token) => this.revoke(token)));
    await Promise.allSettled([...this.work]);
  }
  call(token: string, input: unknown): Promise<unknown> {
    const task = this.dispatch(token, probeRequest(input));
    this.work.add(task);
    void task.finally(() => this.work.delete(task)).catch(() => undefined);
    return task;
  }
  private owned(token: string, probe: Probe): void {
    if (this.sessions.get(token) !== probe || probe.stopping) throw new ControlError("not_found");
  }
  private async dispatch(token: string, request: ProbeRequest): Promise<unknown> {
    if (!this.sessions.has(token)) throw new ControlError("unauthorized");
    if (request.action === "config-status") {
      if (!this.backend.configStatus) throw new ControlError("unavailable");
      const status = await this.backend.configStatus();
      if (!this.sessions.has(token)) throw new ControlError("unauthorized");
      return status;
    }
    if (request.action === "test-rules") {
      const provider = agentProvider(request.agent);
      await provider.validate?.();
      const active = () => {
        if (!this.sessions.has(token)) throw new ControlError("unauthorized");
      };
      active();
      const report = await testCaptureRules(
        this.root,
        request.agent,
        provider.model.attention.rules.map(({ lines, ...rule }) => ({
          ...rule,
          ...(lines === undefined ? {} : { lines }),
        })),
        active,
      );
      active();
      return report;
    }
    if (request.action === "start") return this.start(token, request);
    const probe = this.sessions.get(token);
    if (!probe || probe.id !== request.probe || !probe.terminal)
      throw new ControlError("not_found");
    this.owned(token, probe);
    const id = probe.terminal;
    switch (request.action) {
      case "stop":
        await this.stop(probe);
        if (this.sessions.get(token) === probe) this.sessions.set(token, null);
        return { stopped: true };
      case "send":
      case "keys":
        await this.backend.reply(
          id,
          request.action === "send" ? `${request.text}\r` : PROBE_KEYS[request.key],
        );
        this.owned(token, probe);
        this.input(id);
        return { sent: true };
      case "wait":
        await this.wait(token, probe, request);
        return { ready: true };
      case "screen":
      case "state": {
        const screen = await this.backend.screen(id);
        this.owned(token, probe);
        if (request.action === "screen") {
          if (!request.save) return screen;
          const capture = await saveCapture(
            this.root,
            {
              version: 1,
              agentId: probe.provider?.id ?? "",
              agentVersion: probe.agentVersion ?? "",
              expected: request.save,
              lines: screen.lines,
              title: screen.title,
              cols: screen.cols ?? 0,
              rows: screen.rows ?? 0,
            },
            () => {
              this.owned(token, probe);
            },
          );
          this.owned(token, probe);
          return { capture };
        }
        const verdict = evaluateRules(
          {
            terminalId: id,
            agent: probe.provider?.id ?? "",
            evidence: { title: screen.title, progress: null },
            tail: screen.lines,
          },
          probe.provider?.model.attention.rules.map(({ lines, ...rule }) => ({
            ...rule,
            ...(lines === undefined ? {} : { lines }),
          })),
        );
        const prefix = `rules:${probe.provider?.id ?? ""}:`;
        return {
          state: verdict.state,
          ruleId: verdict.signal.startsWith(prefix) ? verdict.signal.slice(prefix.length) : null,
          hookEvent: null,
          conversationId: probe.conversationId ?? null,
        };
      }
    }
  }
  private async start(
    token: string,
    request: Extract<ProbeRequest, { action: "start" }>,
  ): Promise<unknown> {
    if (this.sessions.get(token)) throw new ControlError("conflict");
    const probe: Probe = {
      id: randomBytes(32).toString("hex"),
      output: Date.now(),
      revision: 0,
      changed: new Set(),
    };
    this.sessions.set(token, probe);
    probe.timer = setTimeout(() => {
      void this.stop(probe)
        .then(() => {
          if (this.sessions.get(token) === probe) this.sessions.set(token, null);
        })
        .catch(() => undefined);
    }, this.limitMs);
    try {
      const provider = await this.operations.provider(request, this.root);
      this.owned(token, probe);
      probe.provider = provider;
      const env = await this.operations.environment();
      this.owned(token, probe);
      const cwd = await this.operations.scratch();
      probe.cwd = cwd;
      this.owned(token, probe);
      const prepared = await this.operations.prepare(provider, request, cwd, env);
      probe.dispose = () => {
        prepared.dispose();
      };
      probe.agentVersion = prepared.agentVersion ?? "";
      probe.conversationId = request.resume ?? prepared.conversationId;
      this.owned(token, probe);
      // Reserve the host ID before create can yield, so expiry can stop a pending spawn.
      probe.terminal = prepared.spec.id ?? randomUUID();
      const id = await this.backend.create({ ...prepared.spec, id: probe.terminal });
      probe.terminal = id;
      this.owned(token, probe);
      await this.backend.show(id, request.agent, probe.conversationId, token, cwd, () => {
        this.owned(token, probe);
      });
      this.owned(token, probe);
      this.attention.add(id, token);
      void this.quiet(id).catch(() => undefined);
      return { probe: probe.id };
    } catch (error) {
      await this.cleanup(probe);
      if (this.sessions.get(token) === probe) this.sessions.set(token, null);
      throw error;
    }
  }
  output(id: string): void {
    for (const probe of this.sessions.values())
      if (probe?.terminal === id) {
        probe.output = Date.now();
        probe.revision++;
        for (const changed of probe.changed) changed();
      }
  }
  async exited(id: string): Promise<void> {
    for (const [token, probe] of this.sessions)
      if (probe?.terminal === id) {
        await this.stop(probe);
        if (this.sessions.get(token) === probe) this.sessions.set(token, null);
      }
  }
  private wait(
    token: string,
    probe: Probe,
    request: Extract<ProbeRequest, { action: "wait" }>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        probe.changed.delete(check);
        probe.changed.delete(cancel);
        try {
          this.owned(token, probe);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Probe unavailable"));
        }
      };
      const cancel = () => {
        if (probe.stopping) done();
      };
      const check = () => {
        clearTimeout(timer);
        if (probe.stopping) {
          done();
          return;
        }
        const remaining =
          request.quiet === undefined
            ? (request.timeout ?? 0) * 1000
            : Math.max(0, request.quiet * 1000 - (Date.now() - probe.output));
        timer = setTimeout(done, remaining);
      };
      // Timeout is elapsed time; output only resets quiet waits.
      if (request.quiet !== undefined) probe.changed.add(check);
      else probe.changed.add(cancel);
      check();
    });
  }
  private stop(probe: Probe): Promise<void> {
    if (probe.stopping) return probe.stopping;
    probe.stopping = Promise.resolve().then(() => this.cleanup(probe));
    for (const changed of probe.changed) changed();
    return probe.stopping;
  }
  private cleanup(probe: Probe): Promise<void> {
    const work = (probe.cleaning ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.release(probe));
    probe.cleaning = work;
    return work;
  }
  private async release(probe: Probe): Promise<void> {
    clearTimeout(probe.timer);
    if (probe.terminal) {
      this.attention.remove(probe.terminal);
      await this.backend.stop(probe.terminal);
      await this.backend.kill(probe.terminal);
      this.backend.removed(probe.terminal);
      delete probe.terminal;
    }
    probe.dispose?.();
    if (probe.cwd) await rm(probe.cwd, { recursive: true, force: true });
  }
}
