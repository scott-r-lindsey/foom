import { listLocalModels, probeInference } from "./inference-probe";
import { createInferenceSource } from "./inference-source";
import { ModelEvaluator } from "./model-evaluator";
import { parseSettingsPatch } from "./settings";
import type { SettingsStore } from "./settings";
import type { EvaluationInput, Verdict } from "./shared/evaluator";
import type {
  ApiProvider,
  InferenceConfig,
  ModelList,
  ProbeResult,
  ProbeUpdate,
} from "./shared/inference";
import type { Settings, SetupState } from "./shared/setup";

const PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai", "google"];

export interface SetupDependencies {
  store: Pick<SettingsStore, "get" | "update">;
  keys: {
    available(): boolean;
    has(provider: ApiProvider): Promise<boolean>;
    get(provider: ApiProvider): Promise<string>;
    set(provider: ApiProvider, key: unknown): Promise<void>;
    remove(provider: ApiProvider): Promise<void>;
  };
  worktreeRoot: string;
  /** Pushes hook and agent settings into the running services. */
  apply(settings: Settings): void;
  evaluator?: (config: InferenceConfig, timeoutMs: number) => Pick<ModelEvaluator, "evaluate">;
  probe?: (
    config: unknown,
    timeoutMs: number,
    onUpdate: (update: ProbeUpdate) => void,
    signal: AbortSignal,
  ) => Promise<ProbeResult>;
  models?: (endpoint: unknown) => Promise<ModelList>;
}

function provider(value: unknown): ApiProvider {
  const match = PROVIDERS.find((entry) => entry === value);
  if (!match) throw new Error("Invalid key provider");
  return match;
}
const same = (a: InferenceConfig, b: InferenceConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Main-side first-run setup. Owns the settings, the stored-key capability, and the
 * app's one model evaluator. A model source is saved only after it passes Run check.
 */
export class Setup {
  private readonly verified: InferenceConfig[] = [];
  private evaluator: Pick<ModelEvaluator, "evaluate">;
  private readonly build: NonNullable<SetupDependencies["evaluator"]>;
  private readonly probe: NonNullable<SetupDependencies["probe"]>;
  private readonly checks = new Map<string, AbortController>();

  constructor(private readonly deps: SetupDependencies) {
    this.build =
      deps.evaluator ??
      ((config, timeoutMs) =>
        new ModelEvaluator(
          createInferenceSource(config, (name) => deps.keys.get(name)),
          timeoutMs,
        ));
    this.probe =
      deps.probe ??
      ((config, timeoutMs, onUpdate, signal) =>
        probeInference(
          config,
          timeoutMs,
          { readKey: (name) => deps.keys.get(name) },
          onUpdate,
          signal,
        ));
    const settings = deps.store.get();
    this.evaluator = this.build(settings.inference, settings.inferenceTimeoutMs);
    deps.apply(settings);
  }

  /** The verdict log's classifier: rules first, then the configured model tier. */
  readonly classify = (input: EvaluationInput): Promise<Verdict> => this.evaluator.evaluate(input);

  async state(): Promise<SetupState> {
    const entries = await Promise.all(
      PROVIDERS.map(async (name) => [name, await this.deps.keys.has(name)] as const),
    );
    return {
      settings: this.deps.store.get(),
      keys: { anthropic: false, openai: false, google: false, ...Object.fromEntries(entries) },
      secureStorage: this.deps.keys.available(),
      worktreeRoot: this.deps.worktreeRoot,
    };
  }

  async save(value: unknown): Promise<SetupState> {
    const patch = parseSettingsPatch(value);
    const { inference } = patch;
    const before = this.deps.store.get();
    if (
      inference &&
      inference.kind !== "rules" &&
      !same(inference, before.inference) &&
      !this.verified.some((entry) => same(entry, inference))
    )
      throw new Error("Run check on this source before using it");
    const settings = await this.deps.store.update(patch);
    if (
      !same(settings.inference, before.inference) ||
      settings.inferenceTimeoutMs !== before.inferenceTimeoutMs
    )
      this.evaluator = this.build(settings.inference, settings.inferenceTimeoutMs);
    this.deps.apply(settings);
    return this.state();
  }

  async setKey(name: unknown, key: unknown): Promise<SetupState> {
    const id = provider(name);
    await this.deps.keys.set(id, key);
    this.forget(id);
    return this.state();
  }

  async removeKey(name: unknown): Promise<SetupState> {
    const id = provider(name);
    await this.deps.keys.remove(id);
    this.forget(id);
    return this.state();
  }

  /** A new or removed key needs a fresh check before its sources can be saved. */
  private forget(id: ApiProvider): void {
    for (let index = this.verified.length - 1; index >= 0; index--)
      if (this.verified[index]?.kind === id) this.verified.splice(index, 1);
  }

  /** One check at a time: starting another cancels the one in progress. */
  async check(
    id: string,
    config: unknown,
    timeoutMs: unknown,
    onUpdate: (update: ProbeUpdate) => void,
  ): Promise<ProbeResult> {
    if (typeof timeoutMs !== "number") throw new Error("Invalid time limit");
    for (const running of this.checks.values()) running.abort();
    const controller = new AbortController();
    this.checks.set(id, controller);
    try {
      const result = await this.probe(config, timeoutMs, onUpdate, controller.signal);
      if (result.ok) {
        const checked = createInferenceConfig(config);
        if (!this.verified.some((entry) => same(entry, checked))) this.verified.push(checked);
      }
      return result;
    } finally {
      if (this.checks.get(id) === controller) this.checks.delete(id);
    }
  }

  cancel(id: string): void {
    this.checks.get(id)?.abort();
  }

  models(endpoint: unknown): Promise<ModelList> {
    return (this.deps.models ?? ((value) => listLocalModels(value, {})))(endpoint);
  }
}

/** The probe already validated this; parse again to store a clean copy. */
function createInferenceConfig(value: unknown): InferenceConfig {
  return parseSettingsPatch({ inference: value }).inference ?? { kind: "rules" };
}
