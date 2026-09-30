import { createInferenceSource, parseInferenceConfig } from "./inference-source";
import { ModelEvaluator } from "./model-evaluator";
import { parseSettingsPatch } from "./settings";
import type { SettingsStore } from "./settings";
import type { EvaluationInput, Verdict } from "./shared/evaluator";
import type { ApiProvider, InferenceConfig, ModelCheck } from "./shared/inference";
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
  evaluator?: (config: InferenceConfig) => Pick<ModelEvaluator, "evaluate" | "runCheck">;
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
  private evaluator: Pick<ModelEvaluator, "evaluate" | "runCheck">;
  private readonly build: NonNullable<SetupDependencies["evaluator"]>;

  constructor(private readonly deps: SetupDependencies) {
    this.build =
      deps.evaluator ??
      ((config) =>
        new ModelEvaluator(createInferenceSource(config, (name) => deps.keys.get(name))));
    this.evaluator = this.build(deps.store.get().inference);
    deps.apply(deps.store.get());
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
    const current = this.deps.store.get().inference;
    if (
      inference &&
      inference.kind !== "rules" &&
      !same(inference, current) &&
      !this.verified.some((entry) => same(entry, inference))
    )
      throw new Error("Run check on this source before using it");
    const settings = await this.deps.store.update(patch);
    if (inference && !same(inference, current)) this.evaluator = this.build(inference);
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

  async check(value: unknown): Promise<ModelCheck> {
    const config = parseInferenceConfig(value);
    if (
      (config.kind === "anthropic" || config.kind === "openai" || config.kind === "google") &&
      !(await this.deps.keys.has(config.kind))
    )
      throw new Error("Save an API key first");
    const result = await this.build(config).runCheck();
    if (result.status === "model" && !this.verified.some((entry) => same(entry, config)))
      this.verified.push(config);
    return result;
  }
}
