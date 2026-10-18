import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedForgeManifest } from "../config/plugins";
import type {
  AdoptionHead,
  PullRequest,
  ForgeObservation,
  ForgeProvider,
  ForgeTransport,
} from "./forge.d";
import type {
  ForgeExecutionState,
  ForgeLifecycleOptions,
  ForgeSelection,
} from "./forge-lifecycle-types";
import { manifestForgeProvider } from "./forge-interpreter";
import { expandForgeArguments } from "./forge-execution";
import { executeForge, ForgeExecutionError, resolveForgeExecutable } from "./forge-process";

function authFailure(stdout: string, stderr: string): boolean {
  return /HTTP(?:\/\d(?:\.\d)?)?\s+(?:401|403)\b|authentication required|not logged in|forbidden/iu.test(
    `${stdout}\n${stderr}`,
  );
}

/** Inactive integration boundary. Only main may select registered plugins and worktree contexts. */
export class ForgeLifecycle {
  private plugins: readonly LoadedForgeManifest[] = [];
  private generation = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly running = new Set<AbortController>();
  private readonly lookups = new Map<string, { until: number; value: PullRequest | undefined }>();
  private readonly resolutions = new Map<
    string,
    { until: number; value: AdoptionHead | undefined }
  >();
  private readonly batches = new Map<
    string,
    { until: number; value: ReadonlyMap<string, ForgeObservation> | undefined }
  >();
  private readonly auth = new Map<string, number>();
  private closed = false;
  private currentState: ForgeExecutionState = "unavailable";
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  constructor(private readonly options: ForgeLifecycleOptions) {
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10000, 10000));
    this.cacheMs = Math.max(0, Math.min(options.cacheMs ?? 20000, 120000));
  }
  state(): ForgeExecutionState {
    return this.currentState;
  }
  replace(plugins: readonly LoadedForgeManifest[]): void {
    if (new Set(plugins.map(({ manifest }) => manifest.id)).size !== plugins.length)
      throw new Error("Duplicate forge ID");
    this.invalidate();
    this.plugins = [...plugins];
  }
  /** Settings, host/remote changes, worktree removal, refresh and shutdown retire in-flight results. */
  invalidate(): void {
    this.generation++;
    this.lookups.clear();
    this.resolutions.clear();
    this.batches.clear();
    this.auth.clear();
    for (const controller of this.running) controller.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.invalidate();
    await Promise.all(this.pending);
  }
  provider(selection: ForgeSelection): ForgeProvider {
    const sample = async <T extends object | undefined>(
      key: unknown,
      cache: Map<string, { until: number; value: T }>,
      read: (provider: ForgeProvider) => Promise<T>,
    ): Promise<T | undefined> => {
      const completion: { finish?: () => void } = {};
      const finished = new Promise<void>((resolve) => {
        completion.finish = resolve;
      });
      this.pending.add(finished);
      const controller = new AbortController();
      const cancel = () => {
        controller.abort();
      };
      selection.signal?.addEventListener("abort", cancel, { once: true });
      if (selection.signal?.aborted) cancel();
      this.running.add(controller);
      const generation = this.generation;
      const { plugin, remote, context } = selection;
      let directory: string | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const execution: { expired: boolean; failure?: ForgeExecutionError } = { expired: false };
      const assertCurrent = () => {
        if (controller.signal.aborted)
          throw new ForgeExecutionError(execution.expired ? "timeout" : "cancelled");
        if (this.closed || generation !== this.generation || !this.plugins.includes(plugin))
          throw new ForgeExecutionError("unavailable");
      };
      const validate = async () => {
        assertCurrent();
        await plugin.validate();
        await context.validate();
        assertCurrent();
      };
      try {
        await validate();
        const resolved = await resolveForgeExecutable(
          plugin.manifest.executables,
          this.options.path,
        );
        const revalidate = async () => {
          await validate();
          if (
            (await resolveForgeExecutable(plugin.manifest.executables, this.options.path))
              .identity !== resolved.identity
          )
            throw new ForgeExecutionError("unavailable");
          assertCurrent();
        };
        const cacheKey = JSON.stringify([
          plugin.manifest.id,
          plugin.digest,
          remote,
          resolved.identity,
          context.identity,
          selection.defaultBranch,
          key,
        ]);
        const cached = cache.get(cacheKey);
        if (cached && cached.until > Date.now()) {
          await revalidate();
          assertCurrent();
          this.currentState = "ready";
          return structuredClone(cached.value);
        }
        directory = await mkdtemp(join(tmpdir(), "foom-forge-"));
        const cwd = directory;
        timeout = setTimeout(() => {
          execution.expired = true;
          controller.abort();
        }, this.timeoutMs);

        const transport: ForgeTransport = async (argv) => {
          if (execution.failure) throw execution.failure;
          try {
            await revalidate();
            const response = await executeForge(
              resolved.executable,
              argv,
              cwd,
              {
                ...(this.options.environment ?? process.env),
                PATH: this.options.path,
                ...plugin.manifest.environment,
              },
              controller.signal,
            );
            if (authFailure(response.code === 0 ? "" : response.stdout, response.stderr))
              throw new ForgeExecutionError("unauthenticated");
            return response;
          } catch (error) {
            execution.failure =
              error instanceof ForgeExecutionError ? error : new ForgeExecutionError("unavailable");
            throw execution.failure;
          }
        };
        const authKey = JSON.stringify([plugin.digest, remote.host, resolved.identity]);
        if ((this.auth.get(authKey) ?? 0) <= Date.now()) {
          const auth = await transport(expandForgeArguments(plugin.manifest.auth.argv, remote));
          if (
            !plugin.manifest.auth.successExitCodes.includes(auth.code) ||
            authFailure(auth.stdout, auth.stderr) ||
            plugin.manifest.auth.failureContains.some((marker) =>
              `${auth.stdout}\n${auth.stderr}`.toLowerCase().includes(marker.toLowerCase()),
            )
          )
            throw new ForgeExecutionError("unauthenticated");
          if (this.auth.size >= 1000) this.auth.clear();
          this.auth.set(authKey, Date.now() + this.cacheMs);
        }
        const value = await read(
          manifestForgeProvider(plugin.manifest, remote, transport, selection.defaultBranch),
        );
        if (execution.failure) throw execution.failure;
        // Finish asynchronous cleanup before the final publication checks.
        await rm(cwd, { recursive: true, force: true });
        directory = undefined;
        await revalidate();
        assertCurrent();
        if (value === undefined) throw new ForgeExecutionError("unavailable");
        this.currentState = "ready";
        if (cache.size >= 1000) cache.clear();
        cache.set(cacheKey, { until: Date.now() + this.cacheMs, value: structuredClone(value) });
        return value;
      } catch (error) {
        this.auth.clear();
        this.lookups.clear();
        this.resolutions.clear();
        this.batches.clear();
        this.currentState = execution.expired
          ? "timeout"
          : error instanceof ForgeExecutionError
            ? error.state
            : "unavailable";
        return undefined;
      } finally {
        if (timeout) clearTimeout(timeout);
        selection.signal?.removeEventListener("abort", cancel);
        this.running.delete(controller);
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          this.pending.delete(finished);
          completion.finish?.();
        }
      }
    };
    return {
      lookup: (branch, number, state) =>
        sample(["lookup", branch, number, state], this.lookups, (p) =>
          p.lookup(branch, number, state),
        ),
      resolve: (number) =>
        sample(["resolve", number], this.resolutions, async (p) => p.resolve?.(number)),
      batch: (matches) => sample(["batch", matches], this.batches, async (p) => p.batch?.(matches)),
    };
  }
}
