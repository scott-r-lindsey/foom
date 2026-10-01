import { isRecent, scanCodeFolder, suggestCodeFolders } from "./code-scan";
import { listLocalModels, probeInference } from "../evaluator/inference-probe";
import { createInferenceSource } from "../evaluator/inference-source";
import { ModelEvaluator } from "../evaluator/model-evaluator";
import { parseSettingsPatch } from "./settings";
import type { SettingsStore } from "./settings";
import type { EvaluationInput, Verdict } from "../../shared/evaluator";
import type {
  ApiProvider,
  InferenceConfig,
  ModelList,
  ProbeResult,
  ProbeUpdate,
} from "../../shared/inference";
import type {
  CodeScan,
  CodeSuggestion,
  RepositoryUpdate,
  ScanProgress,
  Settings,
  SetupState,
} from "../../shared/setup";
import type { WorktreeService } from "../workspace/worktrees";

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
  code: {
    worktrees: Pick<WorktreeService, "listRepositories" | "addRepository" | "removeRepository">;
    /** The native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>;
    home: string;
    scan?: typeof scanCodeFolder;
    now?: () => number;
  };
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
/** How far the quick scan behind a suggestion's count looks. */
const QUICK_SCAN_FOLDERS = 5000;

export class Setup {
  private readonly verified: InferenceConfig[] = [];
  private evaluator: Pick<ModelEvaluator, "evaluate">;
  private readonly build: NonNullable<SetupDependencies["evaluator"]>;
  private readonly probe: NonNullable<SetupDependencies["probe"]>;
  private readonly checks = new Map<string, AbortController>();
  private suggested: readonly string[] = [];
  /** Paths from the latest scan: the only ones the renderer may add or remove. */
  private scanned = new Set<string>();

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

  /**
   * Common code folders that hold repositories, each with a count from a quick scan
   * (the same scan, stopped sooner). Folders without any aren't suggested.
   */
  async codeSuggestions(): Promise<readonly CodeSuggestion[]> {
    const folders = await suggestCodeFolders(this.deps.code.home);
    const scan = this.deps.code.scan ?? scanCodeFolder;
    const found = await Promise.all(
      folders.map((path) =>
        scan(path, { exclude: [this.deps.worktreeRoot], maxFolders: QUICK_SCAN_FOLDERS }).then(
          (result) => ({
            path,
            repositories: result.repositories.length,
            more: result.truncated,
          }),
          () => ({ path, repositories: 0, more: false }),
        ),
      ),
    );
    const suggestions = found.filter((suggestion) => suggestion.repositories > 0);
    this.suggested = suggestions.map((suggestion) => suggestion.path);
    return suggestions;
  }

  /**
   * Scans a suggested folder, the saved one, or (for null) one the user picks. The
   * folder is saved, and its repositories become the only paths `applyRepositories`
   * accepts.
   */
  async scanCode(
    folder: unknown,
    onProgress: (progress: ScanProgress) => void,
  ): Promise<CodeScan | null> {
    let target: string;
    if (folder === null) {
      const picked = await this.deps.code.pickFolder();
      if (picked === null) return null;
      target = picked;
    } else if (
      typeof folder === "string" &&
      (this.suggested.includes(folder) || folder === this.deps.store.get().codeFolder)
    )
      target = folder;
    else throw new Error("Unknown code folder");
    const scan = await (this.deps.code.scan ?? scanCodeFolder)(target, {
      exclude: [this.deps.worktreeRoot],
      onProgress,
    });
    await this.save({ codeFolder: scan.folder });
    this.scanned = new Set(scan.repositories.map((repository) => repository.path));
    const added = new Set(this.deps.code.worktrees.listRepositories().map((entry) => entry.path));
    const now = (this.deps.code.now ?? Date.now)();
    return {
      folder: scan.folder,
      folders: scan.folders,
      truncated: scan.truncated,
      repositories: scan.repositories.map((repository) => ({
        ...repository,
        recent: isRecent(repository.lastActive, now),
        added: added.has(repository.path),
      })),
    };
  }

  /** Adds and removes scanned repositories so that exactly `selected` are added. */
  async applyRepositories(selected: unknown): Promise<RepositoryUpdate> {
    if (
      !Array.isArray(selected) ||
      !selected.every((path): path is string => typeof path === "string" && this.scanned.has(path))
    )
      throw new Error("Choose repositories from the latest scan");
    const wanted = new Set<string>(selected);
    const { worktrees } = this.deps.code;
    const added = new Set(worktrees.listRepositories().map((entry) => entry.path));
    const failures: { path: string; message: string }[] = [];
    for (const path of this.scanned) {
      try {
        if (wanted.has(path) && !added.has(path)) await worktrees.addRepository(path);
        else if (!wanted.has(path) && added.has(path)) await worktrees.removeRepository(path);
      } catch (error) {
        failures.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { repositories: worktrees.listRepositories(), failures };
  }
}

/** The probe already validated this; parse again to store a clean copy. */
function createInferenceConfig(value: unknown): InferenceConfig {
  return parseSettingsPatch({ inference: value }).inference ?? { kind: "rules" };
}
